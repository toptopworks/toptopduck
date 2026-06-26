//! Canonical schema projector (ADR-0032) -- the single source of truth for the
//! type representation shared by the UI and the future LLM payload (DRY). Slice 1
//! is flat CSV types; nested STRUCT/LIST/MAP expansion arrives with JSON (slice 2).


/// Map a raw DuckDB DESCRIBE type string to its single canonical name.
/// DuckDB's DESCRIBE already returns canonical names for most types; this defends
/// against alias leakage and is the one place canonicalization happens.
pub fn canonical_type(raw: &str) -> String {
    let collapsed = collapse_ws(&raw.trim().to_uppercase());
    let bare = match collapsed.as_str() {
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
        // DECIMAL(p,s), TIMESTAMP variants, DATE, TIME, nested -- already canonical.
        _ => return collapsed,
    };
    bare.to_string()
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
        assert_eq!(canonical_type("TIMESTAMP WITH TIME ZONE"), "TIMESTAMP WITH TIME ZONE");
        assert_eq!(canonical_type("DATE"), "DATE");
    }

    #[test]
    fn null_renders_empty() {
        assert_eq!(render_cell(None), "");
        assert_eq!(render_cell(Some("007")), "007");
    }
}
