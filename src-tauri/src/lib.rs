mod engine;
mod settings;

use engine::{base_url, desktop_port, find_node, keep_in_compact, port_in_use, refresh_usage, spawn_engine, stop_child, wait_ready};
use settings::DesktopSettings;
use std::path::PathBuf;
use std::process::Child;
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_autostart::ManagerExt;

struct AppState {
  base_url: String,
  child: Mutex<Option<Child>>,
  settings: Mutex<DesktopSettings>,
}

fn app_root(app: &AppHandle) -> PathBuf {
  if cfg!(debug_assertions) {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
  } else {
    app.path().resource_dir().unwrap_or_else(|_| {
      PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
    })
  }
}

fn data_dir(app: &AppHandle) -> PathBuf {
  app.path().app_config_dir().unwrap_or_else(|_| std::env::temp_dir().join("usage-tracker"))
}

fn persist(app: &AppHandle) {
  if let Some(state) = app.try_state::<AppState>() {
    if let Ok(settings) = state.settings.lock() {
      settings::save(app, &settings);
    }
  }
}

fn compact_url(base: &str) -> String {
  format!("{base}/compact")
}

fn dashboard_url(base: &str) -> String {
  format!("{base}/")
}

fn apply_compact_layout(window: &WebviewWindow, settings: &DesktopSettings) {
  if settings.pinned_top {
    if let Ok(Some(monitor)) = window.current_monitor().or_else(|_| window.primary_monitor()) {
      let scale = monitor.scale_factor();
      let _ = window.set_position(tauri::Position::Physical(*monitor.position()));
      let _ = window.set_size(LogicalSize::new(monitor.size().width as f64 / scale, 48.0));
    }
    let _ = window.set_always_on_top(true);
    return;
  }
  let width = settings.compact_width.unwrap_or(980.0).clamp(360.0, 1920.0);
  let _ = window.set_size(LogicalSize::new(width, 48.0));
  if let (Some(x), Some(y)) = (settings.compact_x, settings.compact_y) {
    let _ = window.set_position(LogicalPosition::new(x, y));
  }
  let _ = window.set_always_on_top(true);
}

fn remember_compact_bounds(app: &AppHandle) {
  let Some(window) = app.get_webview_window("compact") else { return };
  let Some(state) = app.try_state::<AppState>() else { return };
  let Ok(mut settings) = state.settings.lock() else { return };
  if settings.pinned_top {
    return;
  }
  if let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) {
    let scale = window.scale_factor().unwrap_or(1.0);
    settings.compact_x = Some(position.x as f64 / scale);
    settings.compact_y = Some(position.y as f64 / scale);
    settings.compact_width = Some(size.width as f64 / scale);
  }
}

fn create_compact(app: &AppHandle) -> tauri::Result<WebviewWindow> {
  let state = app.state::<AppState>();
  let url = compact_url(&state.base_url);
  let settings = state.settings.lock().map(|guard| guard.clone()).unwrap_or_default();
  let handle = app.clone();
  let parsed = url.parse().expect("compact view URL is valid");
  let window = WebviewWindowBuilder::new(app, "compact", WebviewUrl::External(parsed))
    .title("Usage Tracker")
    .inner_size(settings.compact_width.unwrap_or(980.0).clamp(360.0, 1920.0), 48.0)
    .min_inner_size(360.0, 40.0)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(true)
    .visible(false)
    .on_navigation(move |target| {
      let href = target.as_str().to_string();
      if keep_in_compact(&href) {
        return true;
      }
      open_dashboard_later(handle.clone(), Some(href));
      false
    })
    .build()?;
  apply_compact_layout(&window, &settings);
  if settings.compact_visible {
    let _ = window.show();
  }
  Ok(window)
}

fn open_dashboard_later(app: AppHandle, url: Option<String>) {
  std::thread::spawn(move || {
    let posted = app.clone();
    let _ = app.run_on_main_thread(move || {
      let _ = open_dashboard(&posted, url.as_deref());
    });
  });
}

fn open_dashboard(app: &AppHandle, url: Option<&str>) -> tauri::Result<WebviewWindow> {
  let state = app.state::<AppState>();
  let target = url
    .filter(|value| value.starts_with("http"))
    .map(str::to_string)
    .unwrap_or_else(|| dashboard_url(&state.base_url));
  if let Some(window) = app.get_webview_window("dashboard") {
    let script = format!("window.location.replace({})", serde_json::to_string(&target).unwrap_or_else(|_| "\"/\"".into()));
    let _ = window.eval(&script);
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
    return Ok(window);
  }
  let parsed = target.parse().expect("dashboard URL is valid");
  let mut builder = WebviewWindowBuilder::new(app, "dashboard", WebviewUrl::External(parsed))
    .title("Usage Tracker")
    .inner_size(1280.0, 860.0)
    .min_inner_size(420.0, 320.0)
    .visible(true)
    .skip_taskbar(false)
    .always_on_top(false);
  #[cfg(debug_assertions)]
  {
    builder = builder.devtools(true);
  }
  builder.build()
}

fn toggle_compact(app: &AppHandle, visible: Option<bool>) {
  let window = match app.get_webview_window("compact") {
    Some(window) => window,
    None => match create_compact(app) {
      Ok(window) => window,
      Err(_) => return,
    },
  };
  let show = visible.unwrap_or_else(|| !window.is_visible().unwrap_or(false));
  if show {
    if let Some(state) = app.try_state::<AppState>() {
      if let Ok(settings) = state.settings.lock() {
        apply_compact_layout(&window, &settings);
      }
    }
    let _ = window.show();
    let _ = window.set_focus();
  } else {
    remember_compact_bounds(app);
    let _ = window.hide();
  }
  if let Some(state) = app.try_state::<AppState>() {
    if let Ok(mut settings) = state.settings.lock() {
      settings.compact_visible = show;
    }
  }
  persist(app);
}

fn pin_compact(app: &AppHandle, pinned: bool) {
  if let Some(state) = app.try_state::<AppState>() {
    if let Ok(mut settings) = state.settings.lock() {
      settings.pinned_top = pinned;
    }
  }
  if let Some(window) = app.get_webview_window("compact") {
    if let Some(state) = app.try_state::<AppState>() {
      if let Ok(settings) = state.settings.lock() {
        apply_compact_layout(&window, &settings);
      }
    }
    let _ = window.show();
  } else {
    let _ = create_compact(app);
  }
  persist(app);
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
  let settings = app.state::<AppState>().settings.lock().map(|guard| guard.clone()).unwrap_or_default();
  let compact_item = CheckMenuItem::with_id(app, "compact", "Compact bar", true, settings.compact_visible, None::<&str>)?;
  let dashboard_item = MenuItem::with_id(app, "dashboard", "Open dashboard", true, None::<&str>)?;
  let refresh_item = MenuItem::with_id(app, "refresh", "Refresh usage", true, None::<&str>)?;
  let pin_item = CheckMenuItem::with_id(app, "pin", "Pin to top of screen", true, settings.pinned_top, None::<&str>)?;
  let autostart_enabled = app.autolaunch().is_enabled().unwrap_or(false);
  let autostart_item = CheckMenuItem::with_id(app, "autostart", "Start with this PC", true, autostart_enabled, None::<&str>)?;
  let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
  let menu = Menu::with_items(app, &[
    &compact_item,
    &dashboard_item,
    &refresh_item,
    &PredefinedMenuItem::separator(app)?,
    &pin_item,
    &autostart_item,
    &PredefinedMenuItem::separator(app)?,
    &quit_item,
  ])?;

  let mut tray = TrayIconBuilder::new()
    .menu(&menu)
    .show_menu_on_left_click(false)
    .tooltip("Usage Tracker")
    .on_menu_event(|app, event| match event.id().as_ref() {
      "compact" => {
        let visible = app.get_webview_window("compact").and_then(|window| window.is_visible().ok()).unwrap_or(false);
        toggle_compact(app, Some(!visible));
      }
      "dashboard" => open_dashboard_later(app.clone(), None),
      "refresh" => {
        if let Some(state) = app.try_state::<AppState>() {
          let base = state.base_url.clone();
          std::thread::spawn(move || {
            let _ = refresh_usage(&base);
          });
        }
      }
      "pin" => {
        let pinned = app.state::<AppState>().settings.lock().ok().map(|settings| settings.pinned_top).unwrap_or(false);
        pin_compact(app, !pinned);
      }
      "autostart" => {
        let manager = app.autolaunch();
        if manager.is_enabled().unwrap_or(false) {
          let _ = manager.disable();
        } else {
          let _ = manager.enable();
        }
      }
      "quit" => {
        if let Some(state) = app.try_state::<AppState>() {
          if let Ok(mut child) = state.child.lock() {
            if let Some(child) = child.as_mut() {
              stop_child(child);
            }
          }
        }
        app.exit(0);
      }
      _ => {}
    })
    .on_tray_icon_event(|tray, event| {
      if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
        toggle_compact(tray.app_handle(), None);
      }
    });
  if let Some(icon) = app.default_window_icon() {
    tray = tray.icon(icon.clone());
  }
  tray.build(app)?;
  Ok(())
}

fn start_engine(app: &AppHandle) -> Result<String, String> {
  let port = desktop_port();
  let base = base_url(port);
  if engine::engine_ready(&base) {
    return Ok(base);
  }
  if port_in_use(port) {
    wait_ready(&base, Duration::from_secs(3))?;
    if engine::engine_ready(&base) {
      return Ok(base);
    }
    return Err(format!("Port {port} is already in use by another program."));
  }
  let node = find_node()?;
  let root = app_root(app);
  let data = data_dir(app);
  let child = spawn_engine(&node, &root, &data, port)?;
  if let Some(state) = app.try_state::<AppState>() {
    if let Ok(mut slot) = state.child.lock() {
      *slot = Some(child);
    }
  }
  wait_ready(&base, Duration::from_secs(12))?;
  Ok(base)
}

pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
      if let Some(window) = app.get_webview_window("compact").or_else(|| app.get_webview_window("dashboard")) {
        let _ = window.show();
        let _ = window.set_focus();
      } else {
        toggle_compact(app, Some(true));
      }
    }))
    .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
    .setup(|app| {
      let handle = app.handle().clone();
      let settings = settings::load(&handle);
      app.manage(AppState {
        base_url: base_url(desktop_port()),
        child: Mutex::new(None),
        settings: Mutex::new(settings),
      });
      match start_engine(&handle) {
        Ok(_) => {
          let _ = create_compact(&handle);
        }
        Err(message) => eprintln!("Usage Tracker: {message}"),
      }
      setup_tray(&handle)?;
      Ok(())
    })
    .on_window_event(|window, event| {
      if window.label() != "compact" {
        return;
      }
      match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
          api.prevent_close();
          remember_compact_bounds(window.app_handle());
          let _ = window.hide();
          if let Some(state) = window.try_state::<AppState>() {
            if let Ok(mut settings) = state.settings.lock() {
              settings.compact_visible = false;
            }
          }
          persist(window.app_handle());
        }
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
          remember_compact_bounds(window.app_handle());
        }
        _ => {}
      }
    })
    .build(tauri::generate_context!())
    .expect("Usage Tracker could not start")
    .run(|app, event| {
      if let tauri::RunEvent::Exit = event {
        if let Some(state) = app.try_state::<AppState>() {
          if let Ok(mut child) = state.child.lock() {
            if let Some(child) = child.as_mut() {
              stop_child(child);
            }
          }
        }
      }
    });
}
