import { describe, expect, it } from "vitest";
import { loadErrorMessage } from "../loadErrorMessage";
import type { LoadError } from "../types";

// Covers every LoadError kind the switch narrows (PR #16 review follow-up): the
// Error branch of LoadOutcome had zero frontend coverage before this -- the five
// cases in loadErrorMessage were dead code until runtime.

describe("loadErrorMessage", () => {
  it("returns the .xls rejection hint for LegacyExcel", () => {
    const err: LoadError = { kind: "LegacyExcel" };
    expect(loadErrorMessage(err)).toBe(
      "不支持 .xls 格式（仅支持 .xlsx），请在 Excel 中另存为 .xlsx 后重试",
    );
  });

  it("names the requested format when UnsupportedFormat carries one", () => {
    const err: LoadError = { kind: "UnsupportedFormat", data: { requested: "pdf" } };
    expect(loadErrorMessage(err)).toBe(
      "不支持的格式：pdf（支持 .csv / .parquet / .json / .xlsx）",
    );
  });

  it("falls back to the generic hint when the requested format is empty", () => {
    const err: LoadError = { kind: "UnsupportedFormat", data: { requested: "" } };
    expect(loadErrorMessage(err)).toBe("无法识别的格式");
  });

  it("surfaces the backend detail verbatim for Parse", () => {
    const err: LoadError = { kind: "Parse", data: { detail: "解析失败" } };
    expect(loadErrorMessage(err)).toBe("解析失败");
  });

  it("surfaces the backend detail verbatim for Io", () => {
    const err: LoadError = { kind: "Io", data: { detail: "读取失败" } };
    expect(loadErrorMessage(err)).toBe("读取失败");
  });

  it("surfaces the backend detail verbatim for Other", () => {
    const err: LoadError = { kind: "Other", data: { detail: "未知错误" } };
    expect(loadErrorMessage(err)).toBe("未知错误");
  });
});
