use sysinfo::Disks;
use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize)]
pub struct DeviceInfo {
    pub name: String,
    pub mount_point: PathBuf,
    pub available_space: u64,
    pub total_space: u64,
    pub file_system: String,
    pub is_removable: bool,
}

#[tauri::command]
pub async fn list_devices() -> Result<Vec<DeviceInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let disks = Disks::new_with_refreshed_list();
        let mut devices = Vec::new();

        for disk in disks.iter() {
            if disk.is_removable() {
                devices.push(DeviceInfo {
                    name: disk.name().to_string_lossy().into_owned(),
                    mount_point: disk.mount_point().to_path_buf(),
                    available_space: disk.available_space(),
                    total_space: disk.total_space(),
                    file_system: disk.file_system().to_string_lossy().into_owned(),
                    is_removable: true,
                });
            }
        }

        Ok(devices)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn eject_device(mount_point: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        {
            let status = std::process::Command::new("diskutil")
                .args(["unmount", &mount_point])
                .status()
                .map_err(|e| format!("Failed to run diskutil: {}", e))?;
            if status.success() {
                return Ok(());
            }
            // fallback: try unmountDisk
            let output = std::process::Command::new("diskutil")
                .args(["unmountDisk", &mount_point])
                .output()
                .map_err(|e| format!("Failed to run diskutil: {}", e))?;
            if output.status.success() {
                Ok(())
            } else {
                Err(String::from_utf8_lossy(&output.stderr).to_string())
            }
        }

        #[cfg(target_os = "linux")]
        {
            // Try to resolve the mount point to a block device from /proc/mounts
            let mut device_path = None;
            if let Ok(content) = std::fs::read_to_string("/proc/mounts") {
                for line in content.lines() {
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    if parts.len() >= 2 && parts[1] == mount_point {
                        device_path = Some(parts[0].to_string());
                        break;
                    }
                }
            }

            // If we resolved the device, try to unmount with udisksctl (unprivileged user safe)
            if let Some(dev) = device_path {
                let output = std::process::Command::new("udisksctl")
                    .args(["unmount", "-b", &dev])
                    .output();
                
                if let Ok(out) = output {
                    if out.status.success() {
                        return Ok(());
                    }
                }
            }

            // Fallback: try standard umount
            let output = std::process::Command::new("umount")
                .arg(&mount_point)
                .output()
                .map_err(|e| format!("Failed to run umount: {}", e))?;
            if output.status.success() {
                Ok(())
            } else {
                Err(String::from_utf8_lossy(&output.stderr).to_string())
            }
        }

        #[cfg(target_os = "windows")]
        {
            let mut clean_mount = mount_point.replace('/', "\\");
            if !clean_mount.ends_with('\\') {
                clean_mount.push('\\');
            }
            let escaped_mount = clean_mount.replace("\\", "\\\\");
            let script = format!(
                r#"$vol = Get-WmiObject -Query "SELECT * FROM Win32_Volume WHERE Name='{}'" ; $vol.DriveLetter | ForEach-Object {{ (New-Object -ComObject Shell.Application).NameSpace(17).ParseName($_).InvokeVerb('Eject') }}"#,
                escaped_mount
            );
            let output = std::process::Command::new("powershell")
                .args(["-Command", &script])
                .output()
                .map_err(|e| format!("Failed to run PowerShell: {}", e))?;
            if output.status.success() {
                Ok(())
            } else {
                Err(String::from_utf8_lossy(&output.stderr).to_string())
            }
        }
    }).await.map_err(|e| e.to_string())?
}
