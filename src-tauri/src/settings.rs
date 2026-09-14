use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct DesktopSettings {
  pub compact_visible: bool,
  pub pinned_top: bool,
  pub compact_x: Option<f64>,
  pub compact_y: Option<f64>,
  pub compact_width: Option<f64>,
}

impl Default for DesktopSettings {
  fn default() -> Self {
    Self {
      compact_visible: true,
      pinned_top: false,
      compact_x: None,
      compact_y: None,
      compact_width: None,
    }
  }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app.path().app_config_dir().map_err(|error| error.to_string())?;
  std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
  Ok(dir.join("desktop.json"))
}

pub fn load(app: &AppHandle) -> DesktopSettings {
  let Ok(path) = settings_path(app) else {
    return DesktopSettings::default();
  };
  std::fs::read_to_string(path)
    .ok()
    .and_then(|text| serde_json::from_str(&text).ok())
    .unwrap_or_default()
}

pub fn save(app: &AppHandle, settings: &DesktopSettings) {
  if let Ok(path) = settings_path(app) {
    if let Ok(text) = serde_json::to_string_pretty(settings) {
      let _ = std::fs::write(path, text);
    }
  }
}
