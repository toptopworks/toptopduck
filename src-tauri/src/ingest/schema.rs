//! Canonical schema projector (ADR-0032) -- the single source of truth for the
//! type representation shared by the UI and the future LLM payload (DRY). Slice 1
//! is flat CSV types; nested STRUCT/LIST/MAP expansion arrives with JSON (slice 2).

/// Map a raw DuckDB DESCRIBE type string to its canonical representation
/// (ADR-0032): the physical type verbatim under a single canonical name, with
/// nested STRUCT/LIST/MAP fully expanded -- leaf type aliases canonicalized and
/// field names preserved verbatim (identifiers keep their case). This is the one
/// place canonicalization happens, shared by the UI and the future LLM payload.
///
/// On any parse failure we fall back to whitespace-compacted upper-case, so a
/// surprising type string never breaks the ingest path.
pub fn canonical_type(raw: &str) -> String {
    match parse_type(raw.trim()) {
        Some(node) => render(&node),
        None => collapse_ws(&raw.trim().to_uppercase()),
    }
}

/// One node of a parsed DuckDB type (ADR-0032). Field names keep their original
/// spelling/case; only leaf type names are canonicalized.
enum TypeNode {
    /// A leaf type (already canonicalized), including any opaque parameters,
    /// e.g. `INTEGER`, `DECIMAL(18,2)`, `TIMESTAMP WITH TIME ZONE`.
    Atom(String),
    /// `STRUCT(name TYPE, ...)` -- field name (raw) paired with its field type.
    Struct(Vec<(String, TypeNode)>),
    /// `LIST(ELEMENT)` (also the canonical form of `ELEMENT[]`).
    List(Box<TypeNode>),
    /// `MAP(KEY, VALUE)`.
    Map(Box<TypeNode>, Box<TypeNode>),
}

fn render(node: &TypeNode) -> String {
    match node {
        TypeNode::Atom(s) => s.clone(),
        TypeNode::Struct(fields) => {
            let body: Vec<String> = fields
                .iter()
                .map(|(name, ty)| format!("{name} {}", render(ty)))
                .collect();
            format!("STRUCT({})", body.join(", "))
        }
        TypeNode::List(elem) => format!("LIST({})", render(elem)),
        TypeNode::Map(key, value) => format!("MAP({}, {})", render(key), render(value)),
    }
}

/// Recursive-descent parser over a DuckDB type string. Operates on `char`s so
/// UTF-8 struct field names (JSON keys) survive intact.
struct Parser {
    chars: Vec<char>,
    pos: usize,
}

impl Parser {
    fn new(raw: &str) -> Self {
        Self {
            chars: raw.chars().collect(),
            pos: 0,
        }
    }

    fn peek(&self) -> Option<&char> {
        self.chars.get(self.pos)
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(c) if c.is_whitespace()) {
            self.pos += 1;
        }
    }

    fn expect(&mut self, want: char) -> Option<()> {
        self.skip_ws();
        if self.peek() == Some(&want) {
            self.pos += 1;
            Some(())
        } else {
            None
        }
    }

    /// Parse exactly one type token, leaving the cursor at the next delimiter
    /// (`,`, `)`, `]`, or end). A "type" = a base name, optional parameters in
    /// parens, then any number of array (`[]`) suffixes.
    fn parse_one(&mut self) -> Option<TypeNode> {
        self.skip_ws();
        let mut base = String::new();
        for &c in self.chars.iter().skip(self.pos) {
            if matches!(c, '(' | '[' | ',' | ')' | ']') {
                break;
            }
            base.push(c);
            self.pos += 1;
        }
        let base_key = collapse_ws(base.trim()).to_uppercase();
        if base_key.is_empty() {
            return None;
        }
        match self.peek() {
            Some('(') => {
                self.pos += 1; // consume '('
                self.parse_parameterized(&base_key)
            }
            _ => self.wrap_array(TypeNode::Atom(canonical_leaf(&base_key))),
        }
    }

    /// Dispatch parameter handling by base name. STRUCT/LIST/MAP are containers
    /// whose children are types; everything else (DECIMAL, VARCHAR(n), ...) is an
    /// opaque leaf whose literal parameters pass through verbatim.
    fn parse_parameterized(&mut self, base_key: &str) -> Option<TypeNode> {
        match base_key {
            "STRUCT" => {
                let fields = self.parse_struct_fields()?;
                self.expect(')')?;
                self.wrap_array(TypeNode::Struct(fields))
            }
            "LIST" => {
                let elem = self.parse_one()?;
                self.expect(')')?;
                self.wrap_array(TypeNode::List(Box::new(elem)))
            }
            "MAP" => {
                let key = self.parse_one()?;
                self.expect(',')?;
                let value = self.parse_one()?;
                self.expect(')')?;
                self.wrap_array(TypeNode::Map(Box::new(key), Box::new(value)))
            }
            _ => {
                let inner = self.read_balanced_to_close()?;
                self.wrap_array(TypeNode::Atom(format!(
                    "{base_key}({})",
                    compact_inner(&inner)
                )))
            }
        }
    }

    fn parse_struct_fields(&mut self) -> Option<Vec<(String, TypeNode)>> {
        let mut fields = Vec::new();
        loop {
            self.skip_ws();
            if matches!(self.peek(), Some(')') | None) {
                break;
            }
            let name = self.parse_field_name()?;
            self.skip_ws();
            let ty = self.parse_one()?;
            fields.push((name, ty));
            self.skip_ws();
            match self.peek() {
                Some(',') => self.pos += 1,
                Some(')') | None => break,
                _ => return None,
            }
        }
        Some(fields)
    }

    /// Read a STRUCT field name -- either a double-quoted identifier (preserved
    /// verbatim, including the quotes) or an unquoted run up to whitespace/`,`/`)`.
    fn parse_field_name(&mut self) -> Option<String> {
        self.skip_ws();
        match self.peek()? {
            '"' => {
                self.pos += 1; // consume opening quote
                let mut name = String::from("\"");
                loop {
                    let c = *self.peek()?;
                    self.pos += 1;
                    if c != '"' {
                        name.push(c);
                        continue;
                    }
                    name.push('"');
                    // A doubled `""` is an escaped quote inside the identifier.
                    if self.peek() == Some(&'"') {
                        self.pos += 1;
                        name.push('"');
                    } else {
                        return Some(name);
                    }
                }
            }
            _ => {
                let mut name = String::new();
                while let Some(&c) = self.peek() {
                    if c.is_whitespace() || matches!(c, ',' | ')' | '[') {
                        break;
                    }
                    name.push(c);
                    self.pos += 1;
                }
                (!name.is_empty()).then_some(name)
            }
        }
    }

    /// Consume the raw text of opaque parameters (depth-aware) through the
    /// matching close paren, which is consumed but not returned.
    fn read_balanced_to_close(&mut self) -> Option<String> {
        let mut out = String::new();
        let mut depth = 1; // '(' already consumed by the caller
        while let Some(&c) = self.peek() {
            self.pos += 1;
            match c {
                '(' => {
                    depth += 1;
                    out.push(c);
                }
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(out);
                    }
                    out.push(c);
                }
                _ => out.push(c),
            }
        }
        None // unbalanced
    }

    /// Fold any `TYPE[]` suffixes into LIST wrappers.
    fn wrap_array(&mut self, node: TypeNode) -> Option<TypeNode> {
        let mut node = node;
        while self.expect('[').is_some() {
            self.expect(']')?;
            node = TypeNode::List(Box::new(node));
        }
        Some(node)
    }
}

/// Parse a full type string (top level requires the whole input consumed).
fn parse_type(raw: &str) -> Option<TypeNode> {
    let mut p = Parser::new(raw);
    let node = p.parse_one()?;
    p.skip_ws();
    (p.pos == p.chars.len()).then_some(node)
}

/// Map a bare (no parameters) upper-case type name to its single canonical name.
fn canonical_leaf(base_key: &str) -> String {
    let bare = match base_key {
        "INT" | "INT4" | "INTEGER" | "SIGNED" => "INTEGER",
        "INT8" | "LONG" | "BIGINT" => "BIGINT",
        "INT2" | "SMALLINT" | "SHORT" => "SMALLINT",
        "INT1" | "TINYINT" => "TINYINT",
        "HUGEINT" => "HUGEINT",
        "UTINYINT" => "UTINYINT",
        "USMALLINT" => "USMALLINT",
        "UINTEGER" => "UINTEGER",
        "UBIGINT" => "UBIGINT",
        "UHUGEINT" => "UHUGEINT",
        "FLOAT4" | "FLOAT" | "REAL" => "FLOAT",
        "FLOAT8" | "DOUBLE" => "DOUBLE",
        "BOOL" | "BOOLEAN" => "BOOLEAN",
        "TEXT" | "STRING" | "CHAR" | "VARCHAR" => "VARCHAR",
        _ => return base_key.to_string(),
    };
    bare.to_string()
}

/// Compact whitespace inside opaque parameters (`DECIMAL(18, 2)` -> `18,2`).
/// Single- and double-quoted literals (e.g. ENUM members like `'a, b'`) are
/// tracked so commas/spaces inside them survive untouched; SQL doubled-quote
/// escapes (`''` / `""`) are honoured.
fn compact_inner(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut quote: Option<char> = None;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if let Some(q) = quote {
            out.push(c);
            if c == q {
                // Doubled quote (`''` / `""`) is an escaped quote -- consume both.
                if chars.get(i + 1) == Some(&q) {
                    out.push(chars[i + 1]);
                    i += 2;
                    continue;
                }
                quote = None;
            }
        } else if c == '"' || c == '\'' {
            quote = Some(c);
            out.push(c);
        } else if c.is_whitespace() {
            // Keep a single space only if both neighbours are ordinary parameter
            // chars -- drops spaces adjacent to `(`, `)`, `,` (`18, 2` -> `18,2`).
            let prev = out.chars().last();
            let next = chars[i..].iter().copied().find(|n| !n.is_whitespace());
            let keep = matches!(prev, Some(p) if !matches!(p, '(' | ')' | ','))
                && matches!(next, Some(n) if !matches!(n, '(' | ')' | ','));
            if keep {
                out.push(' ');
            }
        } else {
            out.push(c);
        }
        i += 1;
    }
    out
}

fn collapse_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_space = false;
    for c in s.chars() {
        if c.is_whitespace() {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(c);
            prev_space = false;
        }
    }
    out
}

/// Render a frozen-sample cell (ADR-0026). The value arrives already CAST to
/// VARCHAR in SQL; SQL NULL renders as the empty string.
pub fn render_cell(value: Option<&str>) -> String {
    match value {
        Some(s) => s.to_string(),
        None => String::new(),
    }
}

/// Quote a SQL identifier (double quotes; embedded quotes doubled).
pub fn quote_ident(name: &str) -> String {
    let escaped = name.replace('"', "\"\"");
    format!("\"{escaped}\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalizes_aliases_to_single_name() {
        assert_eq!(canonical_type("INT"), "INTEGER");
        assert_eq!(canonical_type("int4"), "INTEGER");
        assert_eq!(canonical_type("INTEGER"), "INTEGER");
        assert_eq!(canonical_type("TEXT"), "VARCHAR");
        assert_eq!(canonical_type("varchar"), "VARCHAR");
        assert_eq!(canonical_type("string"), "VARCHAR");
        assert_eq!(canonical_type("FLOAT8"), "DOUBLE");
        assert_eq!(canonical_type("BOOL"), "BOOLEAN");
        assert_eq!(canonical_type("INT8"), "BIGINT");
    }

    #[test]
    fn preserves_canonical_parameterized_types() {
        assert_eq!(canonical_type("DECIMAL(10,2)"), "DECIMAL(10,2)");
        assert_eq!(canonical_type("TIMESTAMP"), "TIMESTAMP");
        assert_eq!(
            canonical_type("TIMESTAMP WITH TIME ZONE"),
            "TIMESTAMP WITH TIME ZONE"
        );
        assert_eq!(canonical_type("DATE"), "DATE");
    }

    #[test]
    fn null_renders_empty() {
        assert_eq!(render_cell(None), "");
        assert_eq!(render_cell(Some("007")), "007");
    }

    // --- Nested type expansion (ADR-0032 / issue #6) -----------------------

    #[test]
    fn expands_struct_with_canonical_inner_types() {
        assert_eq!(
            canonical_type("STRUCT(id BIGINT, name VARCHAR)"),
            "STRUCT(id BIGINT, name VARCHAR)"
        );
        // inner aliases canonicalize, field names preserved verbatim
        assert_eq!(
            canonical_type("STRUCT(id INT, score FLOAT4)"),
            "STRUCT(id INTEGER, score FLOAT)"
        );
    }

    #[test]
    fn preserves_struct_field_name_case() {
        // Field names are identifiers -- case must survive (JSON keys like userName).
        assert_eq!(
            canonical_type("STRUCT(userName VARCHAR, Address STRUCT(city VARCHAR))"),
            "STRUCT(userName VARCHAR, Address STRUCT(city VARCHAR))"
        );
    }

    #[test]
    fn expands_list_and_map() {
        assert_eq!(canonical_type("LIST(VARCHAR)"), "LIST(VARCHAR)");
        assert_eq!(canonical_type("LIST(INT)"), "LIST(INTEGER)");
        assert_eq!(
            canonical_type("MAP(VARCHAR, BIGINT)"),
            "MAP(VARCHAR, BIGINT)"
        );
        assert_eq!(canonical_type("MAP(TEXT, INT4)"), "MAP(VARCHAR, INTEGER)");
    }

    #[test]
    fn normalizes_array_suffix_to_list() {
        assert_eq!(canonical_type("INTEGER[]"), "LIST(INTEGER)");
        assert_eq!(canonical_type("VARCHAR[]"), "LIST(VARCHAR)");
    }

    #[test]
    fn expands_deeply_nested_types() {
        // list of structs, struct of lists -- the shapes JSON infers.
        assert_eq!(
            canonical_type("LIST(STRUCT(id BIGINT, tags LIST(VARCHAR)))"),
            "LIST(STRUCT(id BIGINT, tags LIST(VARCHAR)))"
        );
        assert_eq!(
            canonical_type("STRUCT(items LIST(STRUCT(id INT)))"),
            "STRUCT(items LIST(STRUCT(id INTEGER)))"
        );
    }

    #[test]
    fn preserves_quoted_struct_field_names() {
        // DuckDB quotes field names that need it; preserve verbatim.
        assert_eq!(
            canonical_type("STRUCT(\"first name\" VARCHAR, age BIGINT)"),
            "STRUCT(\"first name\" VARCHAR, age BIGINT)"
        );
    }

    #[test]
    fn keeps_opaque_parameterized_leaf_types_verbatim() {
        // DECIMAL precision / VARCHAR(n) are not type-children -- they pass through
        // as opaque leaves with compacted spacing.
        assert_eq!(canonical_type("DECIMAL(18,2)"), "DECIMAL(18,2)");
        assert_eq!(canonical_type("DECIMAL(18, 2)"), "DECIMAL(18,2)");
        assert_eq!(canonical_type("VARCHAR(255)"), "VARCHAR(255)");
    }

    #[test]
    fn preserves_single_quoted_enum_literals() {
        // ENUM members are single-quoted and may contain commas/spaces; compaction
        // must not touch inside the quotes. The space between parameters (after
        // the comma) is compacted, consistent with DECIMAL(18, 2) -> 18,2.
        assert_eq!(canonical_type("ENUM('a, b', 'c')"), "ENUM('a, b','c')");
        assert_eq!(canonical_type("ENUM('it''s', 'x')"), "ENUM('it''s','x')");
    }

    #[test]
    fn normalizes_multidimensional_array_suffixes() {
        assert_eq!(canonical_type("INTEGER[][]"), "LIST(LIST(INTEGER))");
        assert_eq!(canonical_type("VARCHAR(255)[]"), "LIST(VARCHAR(255))");
    }
}
