import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../table";

describe("Table primitives (ADR-0067, issue #168 self-contained)", () => {
  // ADR-0067 retires the styles.css global `table / th / td` element rules; the
  // Table primitives carry their own border / bg / padding utilities so they
  // render correctly with NO global table CSS. This pins the structural
  // invariant -- a regression that drops border / bg-muted would silently
  // revert to relying on the retired global rules. jsdom has no layout engine,
  // so these are className-contract assertions on the real rendered elements,
  // not visual checks. Each token is asserted via split(/\s+/) + toContain so
  // `border` does not match `border-collapse` / `border-b` etc. -- a bare
  // toMatch(/\bborder\b/) passes spuriously against any border-* utility.
  it("Table renders a <table> with border-collapse (no global table rule needed)", () => {
    const { container } = render(
      <Table>
        <TableBody>
          <TableRow>
            <TableCell>x</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const table = container.querySelector("table");
    expect(table).not.toBeNull();
    expect(table?.className.split(/\s+/)).toContain("border-collapse");
  });

  it("TableHead carries its own border + bg-muted + text-sm (no global th rule needed)", () => {
    const { container } = render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>h</TableHead>
          </TableRow>
        </TableHeader>
      </Table>,
    );
    const th = container.querySelector("th");
    expect(th).not.toBeNull();
    // Grid border (border-color from app.css @layer base).
    expect(th?.className.split(/\s+/)).toContain("border");
    // Header tint.
    expect(th?.className.split(/\s+/)).toContain("bg-muted");
    // Font-size (ADR-0067 Decision 2: scale over arbitrary values).
    expect(th?.className.split(/\s+/)).toContain("text-sm");
  });

  it("TableCell carries its own border + text-sm (no global td rule needed)", () => {
    const { container } = render(
      <Table>
        <TableBody>
          <TableRow>
            <TableCell>c</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const td = container.querySelector("td");
    expect(td).not.toBeNull();
    expect(td?.className.split(/\s+/)).toContain("border");
    expect(td?.className.split(/\s+/)).toContain("text-sm");
  });
});
