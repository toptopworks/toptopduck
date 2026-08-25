// CLI fake-tool fixture (issue #671, ADR-0108): a minimal non-interactive
// binary the executor's unit tests spawn in place of a real registered tool
// (the acp-fake-cli / mcp-fake-server precedent). Lives under tests/fixtures/
// (a subdir, so cargo does NOT auto-discover it as an integration-test
// target); declared as a [[bin]] in Cargo.toml so tests resolve its path via
// env!("CARGO_BIN_EXE_cli-fake-tool"). Pure std (no lib import) so the
// fixture stays self-contained. The Tauri bundler never ships it.
//
// Protocol (flags are order-free; positional arguments echo to stdout one
// per line, in order):
//   --pwd            print the current working directory
//   --env NAME       print the env var NAME's value ("unset" when absent)
//   --stderr TEXT    print TEXT to stderr
//   --flood N        print N bytes of 'x' to stdout
//   --sleep MS       sleep MS milliseconds before exiting (cancel tests)
//   --orphan         spawn a grandchild that inherits this process's stdio
//                    and outlives it (reader-reap tests: the held pipe ends
//                    produce no EOF when this process exits)
//   --stdin          read stdin to EOF and echo it verbatim (stdin-delivery
//                    tests, issue #672)
//   --cat FILE       print FILE's raw bytes to stdout (file-delivery tests,
//                    issue #672; "no-file" when the path is unreadable)
//   --exit N         exit with code N (default 0)

use std::io::Read;
use std::thread::sleep;
use std::time::Duration;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut exit_code = 0;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--pwd" => {
                println!("{}", std::env::current_dir().unwrap().display());
            }
            "--env" if i + 1 < args.len() => {
                i += 1;
                let value = std::env::var(&args[i]).unwrap_or_else(|_| "unset".to_string());
                println!("{value}");
            }
            "--stderr" if i + 1 < args.len() => {
                i += 1;
                eprintln!("{}", args[i]);
            }
            "--flood" if i + 1 < args.len() => {
                i += 1;
                let n: usize = args[i].parse().unwrap_or(0);
                let chunk = "x".repeat(8192);
                let mut written = 0;
                while written < n {
                    let take = chunk.len().min(n - written);
                    print!("{}", &chunk[..take]);
                    written += take;
                }
            }
            "--sleep" if i + 1 < args.len() => {
                i += 1;
                let ms: u64 = args[i].parse().unwrap_or(0);
                sleep(Duration::from_millis(ms));
            }
            "--orphan" => {
                // The resident-child class ADR-0108 anticipates: the
                // grandchild inherits stdout (the executor's pipe) and
                // sleeps long past this process's exit, so the pipe's write
                // end stays open with no parent to close it.
                let exe = std::env::current_exe().expect("fixture exe");
                let _ = std::process::Command::new(exe)
                    .arg("--sleep")
                    .arg("30000")
                    .spawn();
            }
            "--stdin" => {
                let mut buf = String::new();
                let _ = std::io::stdin().read_to_string(&mut buf);
                print!("{buf}");
            }
            "--cat" if i + 1 < args.len() => {
                i += 1;
                match std::fs::read(&args[i]) {
                    Ok(bytes) => print!("{}", String::from_utf8_lossy(&bytes)),
                    Err(e) => println!("no-file: {e}"),
                }
            }
            "--exit" if i + 1 < args.len() => {
                i += 1;
                exit_code = args[i].parse().unwrap_or(0);
            }
            positional => {
                println!("{positional}");
            }
        }
        i += 1;
    }
    std::process::exit(exit_code);
}
