import type { LoadError } from "./types";

// Map an ingest LoadError to a user-facing Chinese message. Mirrors the Rust
// `Display for LoadError` wording (model.rs) for the hints that carry an
// actionable suggestion; Parse/Io/Other surface the backend's detail verbatim.
// Pure module (no React) so it is trivially unit-testable without Tauri mocks.
export function loadErrorMessage(err: LoadError): string {
  switch (err.kind) {
    case "LegacyExcel":
      return "不支持 .xls 格式（仅支持 .xlsx），请在 Excel 中另存为 .xlsx 后重试";
    case "UnsupportedFormat":
      return err.data.requested
        ? `不支持的格式：${err.data.requested}（支持 .csv / .parquet / .json / .xlsx）`
        : "无法识别的格式";
    case "Parse":
      return err.data.detail;
    case "Io":
      return err.data.detail;
    case "Other":
      return err.data.detail;
  }
}
