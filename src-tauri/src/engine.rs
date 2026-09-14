use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use std::{env, thread};

pub const DEFAULT_PORT: u16 = 3142;

pub fn desktop_port() -> u16 {
  env::var("USAGE_TRACKER_PORT")
    .ok()
    .and_then(|value| value.parse().ok())
    .filter(|port| *port >= 1)
    .unwrap_or(DEFAULT_PORT)
}

pub fn base_url(port: u16) -> String {
  format!("http://127.0.0.1:{port}")
}

pub fn keep_in_compact(href: &str) -> bool {
  let href = href.trim();
  if href.is_empty()
    || href == "about:blank"
    || href.starts_with("about:blank")
    || href.starts_with("tauri:")
    || href.starts_with("data:")
    || href.starts_with("ipc:")
    || href.starts_with("https://tauri.")
  {
    return true;
  }
  let after_host = href.split_once("://").map(|(_, rest)| rest).unwrap_or(href);
  let path = after_host.split_once('/').map(|(_, path)| path).unwrap_or("");
  let path = path.split(['?', '#']).next().unwrap_or(path);
  path == "compact" || path == "compact.html" || path.starts_with("compact/")
}

pub fn find_node() -> Result<PathBuf, String> {
  if let Ok(path) = env::var("USAGE_TRACKER_NODE") {
    let path = PathBuf::from(path);
    if path.exists() {
      return Ok(path);
    }
  }
  which::which("node").map_err(|_| {
    "Node.js 20 or newer is required. Install it, then reopen Usage Tracker.".to_string()
  })
}

pub fn engine_ready(base: &str) -> bool {
  ureq::get(&format!("{base}/api/meta"))
    .timeout(Duration::from_secs(2))
    .call()
    .map(|response| response.status() == 200)
    .unwrap_or(false)
}

pub fn wait_ready(base: &str, timeout: Duration) -> Result<(), String> {
  let started = Instant::now();
  while started.elapsed() < timeout {
    if engine_ready(base) {
      return Ok(());
    }
    thread::sleep(Duration::from_millis(150));
  }
  Err("The local usage server did not start in time.".into())
}

pub fn port_in_use(port: u16) -> bool {
  format!("127.0.0.1:{port}")
    .parse()
    .ok()
    .and_then(|address| TcpStream::connect_timeout(&address, Duration::from_millis(200)).ok())
    .is_some()
}

pub fn spawn_engine(node: &Path, root: &Path, data_dir: &Path, port: u16) -> Result<Child, String> {
  let server = root.join("server.js");
  if !server.is_file() {
    return Err(format!("Could not find server.js in {}.", root.display()));
  }
  std::fs::create_dir_all(data_dir).map_err(|error| error.to_string())?;
  let mut command = Command::new(node);
  command
    .arg(&server)
    .arg("--port")
    .arg(port.to_string())
    .current_dir(root)
    .env("USAGE_TRACKER_DATA_DIR", data_dir)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
  }
  command.spawn().map_err(|error| format!("Could not start Node.js: {error}"))
}

pub fn refresh_usage(base: &str) -> Result<(), String> {
  let accounts: serde_json::Value = ureq::get(&format!("{base}/api/accounts"))
    .timeout(Duration::from_secs(15))
    .call()
    .map_err(|error| error.to_string())?
    .into_json()
    .map_err(|error| error.to_string())?;
  let token = accounts
    .get("csrfToken")
    .and_then(|value| value.as_str())
    .ok_or_else(|| "The usage server did not return a workspace token.".to_string())?;
  ureq::post(&format!("{base}/api/usage/refresh"))
    .timeout(Duration::from_secs(65))
    .set("Content-Type", "application/json")
    .set("Accept", "application/json")
    .set("Origin", base)
    .set("X-Usage-Token", token)
    .send_string("{}")
    .map_err(|error| error.to_string())?;
  Ok(())
}

pub fn stop_child(child: &mut Child) {
  let _ = child.kill();
  let _ = child.wait();
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn default_desktop_port_is_dedicated() {
    assert_eq!(DEFAULT_PORT, 3142);
    assert_eq!(base_url(3142), "http://127.0.0.1:3142");
  }

  #[test]
  fn compact_window_keeps_blank_and_compact_urls() {
    assert!(keep_in_compact("about:blank"));
    assert!(keep_in_compact("http://127.0.0.1:3142/compact"));
    assert!(keep_in_compact("http://127.0.0.1:3142/compact.html"));
    assert!(keep_in_compact("tauri://localhost/"));
    assert!(!keep_in_compact("http://127.0.0.1:3142/"));
    assert!(!keep_in_compact("http://127.0.0.1:3142/#claude-title"));
    assert!(!keep_in_compact("http://127.0.0.1:3142/settings"));
  }
}
