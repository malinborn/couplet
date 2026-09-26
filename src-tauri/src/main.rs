// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `args_os`, not `args`: `std::env::args` panics on an argument that is
    // not UTF-8 (a file name in a legacy encoding), before anything could say
    // why. The CLI verbs need text and refuse it cleanly; the app itself is
    // left to its own argument handling.
    let verb = std::env::args_os().nth(1);
    let verb = verb.as_deref().and_then(|v| v.to_str());
    if verb == Some("ai") || verb == Some("mcp") {
        let args = match std::env::args_os().map(|a| a.into_string()).collect::<Result<Vec<_>, _>>() {
            Ok(args) => args,
            Err(bad) => {
                eprintln!("couplet: argument is not valid UTF-8: {}", bad.to_string_lossy());
                std::process::exit(2);
            }
        };
        std::process::exit(if verb == Some("ai") {
            md_mini_lib::ai_socket::run_ai_cli(args)
        } else {
            md_mini_lib::mcp_server::run(args)
        });
    }
    md_mini_lib::run()
}
