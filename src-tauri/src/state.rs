use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use uuid::Uuid;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SdCardProfile {
    pub id: String,
    pub profile_type: String, // "Sony" or "Nikon"
    pub volume_name: String,
    pub staging_dir: String,
    pub last_file_path: Option<String>,
    pub last_file_timestamp: Option<u64>,
}

impl SdCardProfile {
    pub fn new(profile_type: String, volume_name: String, staging_dir: String, last_file_path: Option<String>, last_file_timestamp: Option<u64>) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            profile_type,
            volume_name,
            staging_dir,
            last_file_path,
            last_file_timestamp,
        }
    }

    pub fn load_from_sd(sd_root: &Path) -> Result<Self, String> {
        let profile_path = sd_root.join(".ccttrs.json");
        if !profile_path.exists() {
            return Err("Profile not found on SD card".to_string());
        }
        let content = fs::read_to_string(&profile_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&content).map_err(|e| e.to_string())
    }

    pub fn save_to_sd(&self, sd_root: &Path) -> Result<(), String> {
        let profile_path = sd_root.join(".ccttrs.json");
        let content = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        fs::write(&profile_path, content).map_err(|e| e.to_string())
    }
}
