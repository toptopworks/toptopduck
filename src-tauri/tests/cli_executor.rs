// CLI tool executor integration tests (issue #671, ADR-0108): drive the
// spawn engine against the cli-fake-tool fixture. Integration-test target
// (not lib unit tests) because the fixture path resolves via the
// compile-time CARGO_BIN_EXE_ env! -- the acp-fake-cli precedent.

use serde_json::{json, Value};
use tempfile::TempDir;

use toptopduck_lib::cancel::CancelToken;
use toptopduck_lib::cli_tools::config::{
    CliParamDelivery, CliToolConfig, CliToolParam, CliToolSource,
};
use toptopduck_lib::cli_tools::executor::execute;
use toptopduck_lib::provider::tool_calling::ToolUse;

/// The fixture binary (see tests/fixtures/cli_fake_tool.rs).
fn exe() -> &'static str {
    env!("CARGO_BIN_EXE_cli-fake-tool")
}

/// A registered tool wrapping the fixture with a varargs-only parameter
/// table: the whole-binary-wrapper shape (ADR-0108 Decision 4 -- one
/// registration covers the CLI's entire subcommand surface).
fn tool(name: &str) -> CliToolConfig {
    CliToolConfig {
        name: name.to_string(),
        description: "fixture tool".to_string(),
        executable: exe().to_string(),
        argv_template: Vec::new(),
        params: vec![CliToolParam {
            name: "args".to_string(),
            description: "tail args".to_string(),
            delivery: CliParamDelivery::Argv,
            varargs: true,
        }],
        env: Default::default(),
        enabled: true,
        source: CliToolSource::User,
        baseline: None,
    }
}

fn call_with_id(call_id: &str, input: Value) -> ToolUse {
    ToolUse {
        id: call_id.to_string(),
        name: "fake".to_string(),
        input,
    }
}

fn call(input: Value) -> ToolUse {
    call_with_id("tu_1", input)
}

fn run(tool: &CliToolConfig, input: Value) -> toptopduck_lib::tools::ToolOutcome {
    let temp = TempDir::new().unwrap();
    execute(tool, &call(input), temp.path(), &CancelToken::new())
}

#[test]
fn success_result_is_stdout_with_positional_args() {
    let outcome = run(&tool("fake"), json!({"args": ["hello", "world"]}));
    assert!(!outcome.result.is_error);
    assert_eq!(
        outcome.result.content,
        "hello
world
"
    );
    assert_eq!(outcome.result.tool_use_id, "tu_1");
    assert!(outcome.promotion.is_none(), "CLI tools never promote");
}

#[test]
fn nonzero_exit_is_a_structured_error_with_stderr() {
    let outcome = run(
        &tool("fake"),
        json!({"args": ["--stderr", "boom", "--exit", "3"]}),
    );
    assert!(outcome.result.is_error, "exit 3 must be a tool error");
    assert!(
        outcome.result.content.contains("boom"),
        "stderr rides the error: {}",
        outcome.result.content
    );
    assert!(
        outcome.result.content.contains("3"),
        "the exit code is named: {}",
        outcome.result.content
    );
}

#[test]
fn nonempty_stderr_appends_under_a_marker_on_success() {
    let outcome = run(&tool("fake"), json!({"args": ["--stderr", "note", "ok"]}));
    assert!(!outcome.result.is_error);
    assert!(
        outcome.result.content.contains("[stderr]\nnote"),
        "stderr appended with a marker: {}",
        outcome.result.content
    );
    assert!(outcome.result.content.contains("ok"));
}

#[test]
fn over_cap_output_truncates_with_an_explicit_marker() {
    // Overrun the 8 MiB stdout cap by one chunk: the stored content stays
    // at the cap and the marker names the truncation (non-fatal, ADR-0108
    // Decision 5).
    let cap = 8 * 1024 * 1024;
    let flood = (cap + 8192).to_string();
    let outcome = run(&tool("fake"), json!({"args": ["--flood", flood]}));
    assert!(
        !outcome.result.is_error,
        "over-cap is non-fatal: {}",
        outcome.result.content
    );
    assert!(
        outcome.result.content.contains("truncated"),
        "the marker names the truncation"
    );
    // The marker itself can contain an 'x' ("exceeded"); count only the
    // body before the "\n[" marker line.
    let body = outcome.result.content.split("\n[").next().unwrap_or("");
    let x_count = body.matches('x').count();
    assert!(x_count <= cap, "at most the cap is stored: {x_count}");
}

#[test]
fn missing_executable_is_a_call_time_error_and_the_entry_stays() {
    let mut t = tool("fake");
    t.executable = "definitely-not-a-real-tool-xyz".to_string();
    let outcome = run(&t, json!({"args": []}));
    assert!(outcome.result.is_error);
    assert!(
        outcome.result.content.contains("failed to spawn"),
        "spawn failure is structured: {}",
        outcome.result.content
    );
    assert!(
        outcome.result.content.contains("re-arms"),
        "the message states the probe semantics"
    );
}

#[test]
fn invalid_call_errors_before_spawning() {
    let outcome = run(&tool("fake"), json!({"wrong": "shape"}));
    assert!(outcome.result.is_error);
    assert!(
        outcome.result.content.contains("invalid call"),
        "render failure is the call's own error: {}",
        outcome.result.content
    );
}

#[test]
fn undeclared_call_key_errors_before_spawning() {
    // The #1194 guard: a well-formed call plus a key the registration never
    // declares (skill-text/schema drift on an Edited entry) is the call's
    // own error, not a silent drop that runs the tool without the value.
    let outcome = run(&tool("fake"), json!({"args": ["--pwd"], "extra": ["-s"]}));
    assert!(outcome.result.is_error);
    assert!(
        outcome.result.content.contains("invalid call"),
        "the refusal rides the invalid-call channel: {}",
        outcome.result.content
    );
    assert!(
        outcome.result.content.contains("unknown parameter `extra`"),
        "the payload names the undeclared key: {}",
        outcome.result.content
    );
}

#[test]
fn cwd_is_the_session_work_temp_dir() {
    let temp = TempDir::new().unwrap();
    let outcome = execute(
        &tool("fake"),
        &call(json!({"args": ["--pwd"]})),
        temp.path(),
        &CancelToken::new(),
    );
    assert!(!outcome.result.is_error);
    assert_eq!(
        outcome.result.content.trim_end(),
        temp.path().display().to_string(),
        "the child runs in the session work temp dir (fs_acl read-write region)"
    );
}

#[test]
fn registered_env_overlays_the_inherited_environment() {
    let mut t = tool("fake");
    t.env.insert(
        "TOPTOPDUCK_CLI_TEST_ENV".to_string(),
        "from-registration".to_string(),
    );
    let outcome = run(&t, json!({"args": ["--env", "TOPTOPDUCK_CLI_TEST_ENV"]}));
    assert!(!outcome.result.is_error);
    assert_eq!(
        outcome.result.content.trim_end(),
        "from-registration",
        "registration env values reach the child"
    );
}

#[test]
fn a_lingering_grandchild_cannot_hang_the_call() {
    // The fixture spawns a grandchild that inherits stdout and outlives it:
    // the parent's exit alone produces no EOF, and a plain reader join
    // would block forever (the cancel path included). The call must still
    // resolve -- grace, then tree termination forcing EOF -- with the
    // parent's output intact and no loss marker.
    let started = std::time::Instant::now();
    let outcome = run(&tool("fake"), json!({"args": ["--orphan", "parent-done"]}));
    assert!(
        started.elapsed() < std::time::Duration::from_secs(10),
        "the held pipe forces a bounded reap, not a hang"
    );
    assert!(!outcome.result.is_error);
    assert!(
        outcome.result.content.contains("parent-done"),
        "the parent's own output survives: {}",
        outcome.result.content
    );
    assert!(
        !outcome.result.content.contains("read error")
            && !outcome.result.content.contains("never reached EOF"),
        "the grandchild died with the tree, so the read completed cleanly: {}",
        outcome.result.content
    );
}

#[test]
fn round_cancel_kills_the_child_and_surfaces_a_tool_error() {
    let temp = TempDir::new().unwrap();
    let cancel = CancelToken::new();
    // Request before the wait loop: deterministic -- the first poll sees
    // it, kills the tree, and reaps the sleeping child.
    cancel.request();
    let started = std::time::Instant::now();
    let outcome = execute(
        &tool("fake"),
        &call(json!({"args": ["--sleep", "10000", "--exit", "0"]})),
        temp.path(),
        &cancel,
    );
    assert!(outcome.result.is_error);
    assert!(
        outcome
            .result
            .content
            .contains("killed by round cancellation"),
        "cancel maps to a tool error: {}",
        outcome.result.content
    );
    assert!(
        started.elapsed() < std::time::Duration::from_secs(5),
        "the sleeping child is killed, not waited out"
    );
}

// --- file / stdin delivery channels (issue #672, ADR-0108 Decision 4) -------

/// A template-driven tool (the delivery tests need argv elements, unlike
/// the varargs-only wrapper above): `--cat {code}` reads back what the
/// executor wrote, `--stdin` echoes what it piped in.
fn template_tool(name: &str, template: &[&str], params: Vec<CliToolParam>) -> CliToolConfig {
    CliToolConfig {
        name: name.to_string(),
        description: "fixture tool".to_string(),
        executable: exe().to_string(),
        argv_template: template.iter().map(|s| s.to_string()).collect(),
        params,
        env: Default::default(),
        enabled: true,
        source: CliToolSource::User,
        baseline: None,
    }
}

fn file_param(name: &str) -> CliToolParam {
    CliToolParam {
        name: name.to_string(),
        description: "file-delivered value".to_string(),
        delivery: CliParamDelivery::File,
        varargs: false,
    }
}

fn stdin_param(name: &str) -> CliToolParam {
    CliToolParam {
        name: name.to_string(),
        description: "stdin-delivered value".to_string(),
        delivery: CliParamDelivery::Stdin,
        varargs: false,
    }
}

/// No `cli-*.tmp` remains in the work dir after the call (deleted on every
/// exit path -- success, failure, cancel alike).
fn no_temp_files_left(temp: &TempDir) -> bool {
    std::fs::read_dir(temp.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .all(|e| {
            e.file_name()
                .to_str()
                .map(|n| !(n.starts_with("cli-") && n.ends_with(".tmp")))
                .unwrap_or(true)
        })
}

#[test]
fn a_varargs_tail_appends_after_the_rendered_template() {
    // The mixed form (issue #1192): a fixed template carrying the call's
    // invariants plus one varargs parameter appending pandoc's own flags at
    // the argv tail. The fixture echoes one argv element per line, so the
    // stdout order IS the argv order: template first, varargs block last,
    // one element per argument with spaces preserved.
    let argv_param = |name: &str, varargs: bool| CliToolParam {
        name: name.to_string(),
        description: "argv-delivered".to_string(),
        delivery: CliParamDelivery::Argv,
        varargs,
    };
    let tool = template_tool(
        "pandoc-like",
        &["{input}", "-o", "{output}"],
        vec![
            argv_param("input", false),
            argv_param("output", false),
            argv_param("extra", true),
        ],
    );
    let outcome = run(
        &tool,
        json!({
            "input": "in.md",
            "output": "out.docx",
            "extra": ["-s", "--toc", "--metadata", "title=Quarterly Report"]
        }),
    );
    assert!(!outcome.result.is_error, "{}", outcome.result.content);
    assert_eq!(
        outcome.result.content,
        "in.md\n-o\nout.docx\n-s\n--toc\n--metadata\ntitle=Quarterly Report\n"
    );
    // The empty varargs array degenerates to the plain template invocation.
    let plain = run(
        &tool,
        json!({"input": "in.md", "output": "out.docx", "extra": []}),
    );
    assert!(!plain.result.is_error, "{}", plain.result.content);
    assert_eq!(plain.result.content, "in.md\n-o\nout.docx\n");
}

#[test]
fn file_delivery_writes_the_temp_file_and_the_argv_receives_the_path() {
    // The child cats back the file the executor wrote for the `code`
    // parameter: the call's value reaches the tool through the temp file,
    // and the file is gone once the call resolves.
    let temp = TempDir::new().unwrap();
    let tool = template_tool(
        "code-runner",
        &["--cat", "{code}"],
        vec![file_param("code")],
    );
    let outcome = execute(
        &tool,
        &call(json!({"code": "print('hello')"})),
        temp.path(),
        &CancelToken::new(),
    );
    assert!(!outcome.result.is_error, "{}", outcome.result.content);
    assert_eq!(outcome.result.content, "print('hello')");
    assert!(
        no_temp_files_left(&temp),
        "the file-delivery temp file is deleted after the call"
    );
}

#[test]
fn file_delivery_temp_files_are_deleted_on_a_nonzero_exit() {
    let temp = TempDir::new().unwrap();
    let tool = template_tool(
        "code-runner",
        &["--cat", "{code}", "--exit", "3"],
        vec![file_param("code")],
    );
    let outcome = execute(
        &tool,
        &call(json!({"code": "x"})),
        temp.path(),
        &CancelToken::new(),
    );
    assert!(outcome.result.is_error);
    assert!(
        no_temp_files_left(&temp),
        "a failing call deletes its temp file too"
    );
}

#[test]
fn file_delivery_temp_files_are_deleted_on_cancel() {
    // A cancelled call never waits the child out, but its temp file must
    // still not outlive the call (the RAII guard drops on the cancel
    // return, not on the child's exit).
    let temp = TempDir::new().unwrap();
    let cancel = CancelToken::new();
    cancel.request();
    let tool = template_tool(
        "code-runner",
        &["--cat", "{code}", "--sleep", "10000"],
        vec![file_param("code")],
    );
    let outcome = execute(&tool, &call(json!({"code": "x"})), temp.path(), &cancel);
    assert!(outcome.result.is_error);
    assert!(
        no_temp_files_left(&temp),
        "the cancel path cleans the temp file as well"
    );
}

#[test]
fn stdin_delivery_pipes_the_value_and_closes_stdin() {
    // The child echoes stdin to EOF: the value arrives, and the pipe close
    // (not a timeout) terminates its read -- the executor writes the single
    // declared value then drops the pipe.
    let temp = TempDir::new().unwrap();
    let tool = template_tool("stdin-tool", &["--stdin"], vec![stdin_param("payload")]);
    let outcome = execute(
        &tool,
        &call(json!({"payload": "piped body"})),
        temp.path(),
        &CancelToken::new(),
    );
    assert!(!outcome.result.is_error, "{}", outcome.result.content);
    assert_eq!(outcome.result.content, "piped body");
}

#[test]
fn stdin_and_file_channels_combine_in_one_registration() {
    // The interpreter shape end to end: a file-delivered code parameter
    // plus a stdin-delivered input parameter in one call.
    let temp = TempDir::new().unwrap();
    let tool = template_tool(
        "interp",
        &["--stdin", "--cat", "{code}"],
        vec![file_param("code"), stdin_param("input")],
    );
    let outcome = execute(
        &tool,
        &call(json!({"code": "CODE", "input": "DATA"})),
        temp.path(),
        &CancelToken::new(),
    );
    assert!(!outcome.result.is_error, "{}", outcome.result.content);
    assert_eq!(outcome.result.content, "DATACODE");
    assert!(no_temp_files_left(&temp));
}

#[test]
fn a_child_that_never_reads_stdin_still_succeeds_without_a_marker() {
    // The never-reading child is the common tool shape (many CLIs succeed
    // without touching stdin): the value fits the pipe buffer, the write
    // completes while the child sleeps, and the call resolves clean -- no
    // incomplete-delivery marker.
    let temp = TempDir::new().unwrap();
    let tool = template_tool(
        "stdin-tool",
        &["--sleep", "500", "--exit", "0"],
        vec![stdin_param("payload")],
    );
    let outcome = execute(
        &tool,
        &call(json!({"payload": "uninspected body"})),
        temp.path(),
        &CancelToken::new(),
    );
    assert!(!outcome.result.is_error, "{}", outcome.result.content);
    assert!(
        !outcome.result.content.contains("stdin delivery incomplete"),
        "a completed write is not an incomplete delivery: {}",
        outcome.result.content
    );
}

#[test]
fn a_broken_stdin_pipe_marks_the_delivery_incomplete() {
    // A value larger than the pipe buffer, a child that exits without
    // reading: the write breaks partway (EPIPE), and the outcome carries
    // the explicit marker -- partial delivery never masquerades as complete
    // (the write-side twin of the read side's decorate doctrine).
    let temp = TempDir::new().unwrap();
    let tool = template_tool("stdin-tool", &["--exit", "0"], vec![stdin_param("payload")]);
    let big = "x".repeat(1024 * 1024);
    let outcome = execute(
        &tool,
        &call(json!({"payload": big})),
        temp.path(),
        &CancelToken::new(),
    );
    assert!(
        !outcome.result.is_error,
        "exit 0 stays a success: {}",
        outcome.result.content
    );
    assert!(
        outcome.result.content.contains("stdin delivery incomplete"),
        "the marker names the partial delivery: {}",
        outcome.result.content
    );
}

/// `run` keeps the temp dir alive for spill assertions (issue #1215): the
/// spill file lives under the session temp's `tool_output/`, so the test
/// must own the dir past the call.
fn run_keep_temp(
    tool: &CliToolConfig,
    input: Value,
    call_id: &str,
) -> (toptopduck_lib::tools::ToolOutcome, TempDir) {
    let temp = TempDir::new().unwrap();
    let outcome = execute(
        tool,
        &call_with_id(call_id, input),
        temp.path(),
        &CancelToken::new(),
    );
    (outcome, temp)
}

#[test]
fn over_cap_stdout_spills_the_full_range_to_tool_output() {
    // Issue #1215: the stdout cap stops being data loss -- the full byte
    // range lands in `tool_output/` under the deterministic
    // `<tool>-<call-id>` name, and the tool result carries the truncation
    // marker plus the path (the capped head doubles as the preview).
    let cap = 8 * 1024 * 1024;
    let overflow = 8192;
    let (outcome, temp) = run_keep_temp(
        &tool("fake"),
        json!({"args": ["--flood", (cap + overflow).to_string()]}),
        "tu_spill",
    );
    assert!(!outcome.result.is_error, "over-cap stays non-fatal");
    let spilled = temp.path().join("tool_output").join("fake-tu_spill.csv");
    assert_eq!(
        std::fs::metadata(&spilled)
            .expect("the spill file exists")
            .len() as usize,
        cap + overflow,
        "the FULL byte range, not the truncation"
    );
    assert!(
        outcome.result.content.contains("truncated"),
        "the marker still names the truncation"
    );
    assert!(
        outcome.result.content.contains("spilled to"),
        "the spill is explicit, not implied: {}",
        outcome.result.content
    );
    assert!(
        outcome
            .result
            .content
            .contains(spilled.to_string_lossy().as_ref()),
        "the result names the spill path: {}",
        outcome.result.content
    );
}

#[test]
fn under_cap_stdout_leaves_no_spill() {
    // The under-cap contract is unchanged: no file, no marker, not even the
    // `tool_output/` side effect.
    let (outcome, temp) =
        run_keep_temp(&tool("fake"), json!({"args": ["--flood", "1000"]}), "tu_ok");
    assert!(!outcome.result.is_error);
    assert!(
        !outcome.result.content.contains("spilled"),
        "no spill note under the cap: {}",
        outcome.result.content
    );
    assert!(
        !temp.path().join("tool_output").exists(),
        "under-cap: no tool_output side effect"
    );
}

#[test]
fn over_cap_stdout_on_a_nonzero_exit_still_spills_and_the_error_names_the_path() {
    // Exit-code orthogonality (issue #1215): the tee lives in the reader,
    // below the exit-status branch, so a failing tool's stdout spills the
    // same way and the error content carries the path -- without the
    // capped head (stderr is the error's payload).
    let cap = 8 * 1024 * 1024;
    let (outcome, temp) = run_keep_temp(
        &tool("fake"),
        json!({"args": ["--flood", (cap + 8192).to_string(), "--exit", "3"]}),
        "tu_err",
    );
    assert!(outcome.result.is_error, "exit 3 stays an error");
    let spilled = temp.path().join("tool_output").join("fake-tu_err.csv");
    assert_eq!(
        std::fs::metadata(&spilled)
            .expect("spilled despite the non-zero exit")
            .len() as usize,
        cap + 8192,
        "the spill ignores the exit status"
    );
    assert!(
        outcome
            .result
            .content
            .contains(spilled.to_string_lossy().as_ref()),
        "the error names the spill path: {}",
        outcome.result.content
    );
    assert!(
        !outcome.result.content.contains("xxxxxxxx"),
        "the capped head does not ride the error: {}",
        outcome.result.content.len()
    );
}

#[test]
fn a_json_stdout_spills_with_the_json_extension() {
    // The extension sniff: a JSON head routes the spill to `.json` so the
    // derived-source dispatcher can hand it to `read_json_auto` (the
    // extension is its only routing signal). `--cat` replays a real JSON
    // byte stream through stdout.
    let cap = 8 * 1024 * 1024;
    let payload = format!("  [{}]", "1,".repeat(cap / 2 + 8192));
    let src = TempDir::new().unwrap();
    let file = src.path().join("big.json");
    std::fs::write(&file, &payload).unwrap();
    let (outcome, temp) = run_keep_temp(
        &tool("fake"),
        json!({"args": ["--cat", file.to_string_lossy()]}),
        "tu_json",
    );
    assert!(
        !outcome.result.is_error,
        "over-cap is non-fatal: {}",
        outcome.result.content
    );
    let spilled = temp.path().join("tool_output").join("fake-tu_json.json");
    assert_eq!(
        std::fs::read(&spilled)
            .expect("the .json spill exists")
            .len(),
        payload.len(),
        "the full JSON byte range"
    );
}

#[test]
fn distinct_call_ids_keep_distinct_spill_files() {
    // Deterministic means distinct, not singleton: two over-cap calls of
    // one tool in one round (distinct call ids, one temp dir) each keep
    // their own file -- no clobbering.
    let cap = 8 * 1024 * 1024;
    let temp = TempDir::new().unwrap();
    for id in ["tu_a", "tu_b"] {
        let call = call_with_id(id, json!({"args": ["--flood", (cap + 8192).to_string()]}));
        let outcome = execute(&tool("fake"), &call, temp.path(), &CancelToken::new());
        assert!(!outcome.result.is_error);
    }
    let names: Vec<String> = std::fs::read_dir(temp.path().join("tool_output"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(
        names.contains(&"fake-tu_a.csv".to_string()),
        "both files survive: {names:?}"
    );
    assert!(
        names.contains(&"fake-tu_b.csv".to_string()),
        "both files survive: {names:?}"
    );
}
