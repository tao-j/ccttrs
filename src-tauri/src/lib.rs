mod copy;
mod state;
mod sys;

use serde::Serialize;
use state::SdCardProfile;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

struct AppState {
    cancel_tokens: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

#[derive(Clone, Serialize)]
struct ProgressPayload {
    sd_path: String,
    files_copied: usize,
    files_skipped: usize,
    total_files: usize,
    bytes_copied: usize,
    total_bytes: usize,
    true_bytes_copied: usize,
    elapsed_secs: f64,
    current_file: String,
}

#[tauri::command]
async fn load_profile(sd_path: String) -> Result<SdCardProfile, String> {
    tauri::async_runtime::spawn_blocking(move || SdCardProfile::load_from_sd(Path::new(&sd_path)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn init_profile(
    sd_path: String,
    profile_type: String,
    volume_name: String,
    staging_dir: String,
    last_file_path: Option<String>,
    last_file_timestamp: Option<u64>,
    rename_nev_to_r3d: Option<bool>,
) -> Result<SdCardProfile, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let profile = SdCardProfile::new(
            profile_type,
            volume_name,
            staging_dir,
            last_file_path,
            last_file_timestamp,
            rename_nev_to_r3d.unwrap_or(true),
        );
        profile.save_to_sd(Path::new(&sd_path))?;
        Ok(profile)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn start_copy(
    app: AppHandle,
    state: State<'_, AppState>,
    sd_path: String,
    staging_dir: Option<String>,
) -> Result<(), String> {
    let cancel_token = Arc::new(AtomicBool::new(false));
    {
        let mut tokens = state.cancel_tokens.lock().map_err(|e| e.to_string())?;
        tokens.insert(sd_path.clone(), cancel_token.clone());
    }

    let tokens_clone = state.cancel_tokens.clone();

    tauri::async_runtime::spawn(async move {
        let sd_root = std::path::PathBuf::from(&sd_path);
        let app_clone = app.clone();
        let path_clone = sd_path.clone();

        let res = tauri::async_runtime::spawn_blocking(move || {
            let mut profile = SdCardProfile::load_from_sd(&sd_root)?;

            // Apply staging dir override if provided
            if let Some(new_dir) = staging_dir {
                if profile.staging_dir != new_dir {
                    profile.staging_dir = new_dir;
                    profile.save_to_sd(&sd_root)?;
                }
            }

            crate::copy::run_sync(&sd_root, &mut profile, cancel_token, move |progress| {
                let _ = app_clone.emit(
                    "copy-progress",
                    ProgressPayload {
                        sd_path: path_clone.clone(),
                        files_copied: progress.files_copied,
                        files_skipped: progress.files_skipped,
                        total_files: progress.total_files,
                        bytes_copied: progress.bytes_copied,
                        total_bytes: progress.total_bytes,
                        true_bytes_copied: progress.true_bytes_copied,
                        elapsed_secs: progress.elapsed_secs,
                        current_file: progress.current_file,
                    },
                );
            })
        })
        .await
        .map_err(|e| e.to_string());

        match res {
            Ok(Ok(())) => {
                let _ = app.emit("copy-finished", sd_path.clone());
            }
            Ok(Err(e)) => {
                let _ = app.emit("copy-error", format!("{}|{}", sd_path, e));
            }
            Err(e) => {
                let _ = app.emit("copy-error", format!("{}|{}", sd_path, e));
            }
        }

        if let Ok(mut tokens) = tokens_clone.lock() {
            tokens.remove(&sd_path);
        }
    });
    Ok(())
}

#[tauri::command]
fn cancel_copy(state: State<'_, AppState>, sd_path: String) -> Result<(), String> {
    let mut tokens = state.cancel_tokens.lock().map_err(|e| e.to_string())?;
    if let Some(token) = tokens.remove(&sd_path) {
        token.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            cancel_tokens: Arc::new(Mutex::new(HashMap::new())),
        })
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            load_profile,
            init_profile,
            start_copy,
            cancel_copy,
            sys::list_devices,
            sys::eject_device,
            copy::list_media_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
