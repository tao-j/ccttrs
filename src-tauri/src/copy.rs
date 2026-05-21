use std::fs;
use std::path::{Path, PathBuf};
// No longer used dynamically but kept for dependency parity
use std::time::{SystemTime, Instant};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::io::Read;
use std::time::Duration;
use uuid::Uuid;

use crate::state::SdCardProfile;

use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct CopyProgress {
    pub files_copied: usize,
    pub files_skipped: usize,
    pub total_files: usize,
    pub bytes_copied: usize,
    pub total_bytes: usize,
    pub true_bytes_copied: usize,
    pub elapsed_secs: f64,
    pub current_file: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct FileMeta {
    pub path: PathBuf,
    pub name: String,
    pub size: u64,
    pub modified: u64,
}

#[tauri::command]
pub async fn list_media_files(sd_path: String, profile_type: String) -> Result<Vec<FileMeta>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut files = Vec::new();
        let root = Path::new(&sd_path);
        scan_media_paths(root, &profile_type, &mut files)?;
        
        // Sort descending by modified time
        files.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| b.name.cmp(&a.name)));
        Ok(files)
    }).await.map_err(|e| e.to_string())?
}

pub fn run_sync(
    sd_root: &Path,
    profile: &mut SdCardProfile,
    cancel_flag: Arc<std::sync::atomic::AtomicBool>,
    on_progress: impl Fn(CopyProgress) + Send + Sync,
) -> Result<(), String> {
    let mut files = Vec::new();
    scan_media_paths(sd_root, &profile.profile_type, &mut files)?;

    // Sort by modified time, then by filename
    files.sort_by(|a, b| {
        a.modified.cmp(&b.modified).then_with(|| a.name.cmp(&b.name))
    });

    // Filter files that are "new"
    let new_files: Vec<_> = if let (Some(last_path), Some(last_ts)) = (&profile.last_file_path, profile.last_file_timestamp) {
        files.into_iter().filter(|f| {
            f.modified > last_ts || (f.modified == last_ts && f.name > *last_path)
        }).collect()
    } else {
        files
    };

    let total = new_files.len();
    if total == 0 {
        return Ok(());
    }

    let total_bytes: usize = new_files.iter().map(|f| f.size as usize).sum();

    let staging_dir = Path::new(&profile.staging_dir);
    if !staging_dir.exists() {
        fs::create_dir_all(staging_dir).map_err(|e| e.to_string())?;
    }

    let copied_count = Arc::new(AtomicUsize::new(0));
    let skipped_count = Arc::new(AtomicUsize::new(0));
    let bytes_copied = Arc::new(AtomicUsize::new(0)); // Visual progress bar
    let true_bytes_copied = Arc::new(AtomicUsize::new(0)); // Actual physical io metrics
    let current_filename = Arc::new(Mutex::new(String::new()));
    let start_time = Instant::now();
    let is_done = Arc::new(std::sync::atomic::AtomicBool::new(false));

    let results = std::thread::scope(|s| {
        let reporter_copied_count = copied_count.clone();
        let reporter_skipped_count = skipped_count.clone();
        let reporter_bytes_copied = bytes_copied.clone();
        let reporter_true_bytes = true_bytes_copied.clone();
        let reporter_current_filename = current_filename.clone();
        let reporter_is_done = is_done.clone();
        let on_progress_ref = &on_progress;

        s.spawn(move || {
            while !reporter_is_done.load(Ordering::Relaxed) {
                let current_count = reporter_copied_count.load(Ordering::Relaxed);
                let current_skipped = reporter_skipped_count.load(Ordering::Relaxed);
                let current_bytes = reporter_bytes_copied.load(Ordering::Relaxed);
                let current_true = reporter_true_bytes.load(Ordering::Relaxed);
                let filename = reporter_current_filename.lock().unwrap().clone();
                
                on_progress_ref(CopyProgress {
                    files_copied: current_count,
                    files_skipped: current_skipped,
                    total_files: total,
                    bytes_copied: current_bytes,
                    total_bytes,
                    true_bytes_copied: current_true,
                    elapsed_secs: start_time.elapsed().as_secs_f64(),
                    current_file: filename,
                });
                std::thread::sleep(Duration::from_millis(100));
            }
        });

        // Run sequential IO block on current thread
        let res: Vec<_> = new_files.iter().map(|f| {
            if cancel_flag.load(Ordering::Relaxed) {
                return Err("Cancelled by user".to_string());
            }

            let file_name = f.path.file_name().unwrap().to_string_lossy().into_owned();
            let mut dest_path = staging_dir.join(&file_name);
            
            let mut should_copy = true;

            if dest_path.exists() {
                if let Ok(dest_meta) = fs::metadata(&dest_path) {
                    if dest_meta.len() == f.size {
                        should_copy = false;
                    } else {
                        dest_path = append_uuid(&dest_path);
                    }
                }
            }

            if should_copy {
                if let Err(e) = fs::copy(&f.path, &dest_path) {
                    return Err(e.to_string());
                }
                let _ = true_bytes_copied.fetch_add(f.size as usize, Ordering::SeqCst);
            } else {
                let _ = skipped_count.fetch_add(1, Ordering::SeqCst);
            }
            
            let _ = copied_count.fetch_add(1, Ordering::SeqCst);
            let _ = bytes_copied.fetch_add(f.size as usize, Ordering::SeqCst);
            
            if let Ok(mut name_lock) = current_filename.lock() {
                *name_lock = file_name.clone();
            }

            Ok(f)
        }).collect();

        is_done.store(true, Ordering::Relaxed);
        
        let final_count = copied_count.load(Ordering::Relaxed);
        let final_skipped = skipped_count.load(Ordering::Relaxed);
        let final_bytes = bytes_copied.load(Ordering::Relaxed);
        let final_true = true_bytes_copied.load(Ordering::Relaxed);
        let filename = current_filename.lock().unwrap().clone();
        
        // Final emit 100%
        on_progress(CopyProgress {
            files_copied: final_count,
            files_skipped: final_skipped,
            total_files: total,
            bytes_copied: final_bytes,
            total_bytes,
            true_bytes_copied: final_true,
            elapsed_secs: start_time.elapsed().as_secs_f64(),
            current_file: filename,
        });

        res
    });

    // Check for errors and find the last successfully copied file
    let mut last_success: Option<&FileMeta> = None;
    for res in results.iter() {
        match res {
            Ok(f) => {
                if last_success.is_none() || f.modified > last_success.as_ref().unwrap().modified || (f.modified == last_success.as_ref().unwrap().modified && f.name > last_success.as_ref().unwrap().name) {
                    last_success = Some(f);
                }
            }
            Err(e) => return Err(e.to_string()),
        }
    }



    // Update profile
    if let Some(f) = last_success {
        profile.last_file_path = Some(f.name.clone());
        profile.last_file_timestamp = Some(f.modified);
        profile.save_to_sd(sd_root)?;
    }

    Ok(())
}

#[allow(dead_code)]
fn compute_md5(path: &Path) -> Option<[u8; 16]> {
    let mut file = fs::File::open(path).ok()?;
    let mut context = md5::Context::new();
    let mut buffer = [0; 4 * 1024 * 1024]; // 4MB chunk buffer
    
    loop {
        let count = file.read(&mut buffer).ok()?;
        if count == 0 {
            break;
        }
        context.consume(&buffer[..count]);
    }
    
    Some(context.finalize().into())
}

fn append_uuid(path: &Path) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new(""));
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    
    let uuid_str = Uuid::new_v4().to_string();
    let unique = uuid_str.split('-').next().unwrap_or("dup");
    
    let new_name = if ext.is_empty() {
        format!("{}_{}", stem, unique)
    } else {
        format!("{}_{}.{}", stem, unique, ext)
    };
    
    parent.join(new_name)
}

fn find_case_insensitive_path(root: &Path, components: &[&str]) -> Option<PathBuf> {
    let mut current = root.to_path_buf();
    for &comp in components {
        let mut found = false;
        if let Ok(entries) = fs::read_dir(&current) {
            for entry in entries.flatten() {
                if let Some(name) = entry.file_name().to_str() {
                    if name.eq_ignore_ascii_case(comp) {
                        current = entry.path();
                        found = true;
                        break;
                    }
                }
            }
        }
        if !found {
            return None;
        }
    }
    Some(current)
}

fn scan_media_paths(root: &Path, profile_type: &str, files: &mut Vec<FileMeta>) -> Result<(), String> {
    let mut paths_to_scan = Vec::new();
    
    if let Some(dcim) = find_case_insensitive_path(root, &["DCIM"]) {
        if dcim.is_dir() {
            paths_to_scan.push(dcim);
        }
    }
    
    if profile_type == "Sony" {
        if let Some(clip) = find_case_insensitive_path(root, &["PRIVATE", "M4ROOT", "CLIP"]) {
            if clip.is_dir() {
                paths_to_scan.push(clip);
            }
        }
    }
    
    for path in paths_to_scan {
        scan_dir_recursive(&path, files)?;
    }
    
    Ok(())
}

fn scan_dir_recursive(dir: &Path, files: &mut Vec<FileMeta>) -> Result<(), String> {
    if !dir.is_dir() {
        return Ok(());
    }

    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();

        if path.is_dir() {
            scan_dir_recursive(&path, files)?;
        } else {
            // Ignore hidden files like .ccttrs.json etc.
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if name.starts_with('.') {
                    continue;
                }
            }

            let metadata = match fs::metadata(&path) {
                Ok(m) => m,
                Err(_) => continue, // Skip files we cannot query metadata for
            };

            let modified = metadata.modified()
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)))
                .map(|d| d.as_secs())
                .unwrap_or(0);

            files.push(FileMeta {
                path: path.clone(),
                name: path.file_name().unwrap_or_default().to_string_lossy().to_string(),
                size: metadata.len(),
                modified,
            });
        }
    }
    Ok(())
}
