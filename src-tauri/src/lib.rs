use std::sync::Mutex;

use eyre::WrapErr;
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, Manager, State};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_store::StoreExt;

type IdType = u16;

struct AppState {
    uv_info: UvInfo,
    next_id: IdType,
    children: std::collections::HashMap<IdType, SpawnedProcessState>,
}

enum SpawnedProcessState {
    /// Initial step taken, id token has been assigned.
    TokenAssigned,
    /// Thread has been spawned to start the process.
    ThreadSpawned {
        join_handle: std::thread::JoinHandle<eyre::Result<()>>,
    },
    /// Process is running.
    Running {
        join_handle: std::thread::JoinHandle<eyre::Result<()>>,
        child: Box<dyn process_wrap::std::ChildWrapper>,
    },
    /// Process has exited.
    #[allow(dead_code)]
    Exited { status: std::process::ExitStatus },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "state"
)]
enum PGState {
    TokenAssigned,
    ThreadSpawned,
    Running,
    Exited,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackageConfig {
    python_version: String,
    packages: Vec<PackageInfo>,
}

impl Default for PackageConfig {
    fn default() -> Self {
        Self {
            python_version: "3.14.6".to_string(),
            packages: vec![
                PackageInfo {
                    name: "numpy".to_string(),
                    version: None,
                    desc: Some("Fundamental package for scientific computing".to_string()),
                    url: Some("https://numpy.org/".to_string()),
                    source: "popular".to_string(),
                    selected: true,
                },
                PackageInfo {
                    name: "pandas".to_string(),
                    version: None,
                    desc: Some("Data analysis and manipulation tool".to_string()),
                    url: Some("https://pandas.pydata.org/".to_string()),
                    source: "popular".to_string(),
                    selected: true,
                },
                PackageInfo {
                    name: "matplotlib".to_string(),
                    version: None,
                    desc: Some("Comprehensive 2D plotting library".to_string()),
                    url: Some("https://matplotlib.org/".to_string()),
                    source: "popular".to_string(),
                    selected: true,
                },
                PackageInfo {
                    name: "scipy".to_string(),
                    version: None,
                    desc: Some("Scientific computing library".to_string()),
                    url: Some("https://scipy.org/".to_string()),
                    source: "popular".to_string(),
                    selected: true,
                },
                PackageInfo {
                    name: "scikit-learn".to_string(),
                    version: None,
                    desc: Some("Machine learning library".to_string()),
                    url: Some("https://scikit-learn.org/".to_string()),
                    source: "popular".to_string(),
                    selected: true,
                },
                PackageInfo {
                    name: "jupyterlab".to_string(),
                    version: None,
                    desc: Some("Web-based interactive development environment".to_string()),
                    url: Some("https://jupyterlab.readthedocs.io/".to_string()),
                    source: "popular".to_string(),
                    selected: true,
                },
                PackageInfo {
                    name: "seaborn".to_string(),
                    version: None,
                    desc: Some("Statistical data visualization".to_string()),
                    url: Some("https://seaborn.pydata.org/".to_string()),
                    source: "popular".to_string(),
                    selected: true,
                },
                PackageInfo {
                    name: "nbgrader".to_string(),
                    version: None,
                    desc: Some("Tool for creating and grading assignments in Jupyter".to_string()),
                    url: Some("https://nbgrader.readthedocs.io/".to_string()),
                    source: "popular".to_string(),
                    selected: true,
                },
            ],
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackageInfo {
    name: String,
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    desc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    source: String,
    selected: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParsedPyproject {
    python_version: Option<String>,
    packages: Vec<PackageInfo>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "event")]
struct SpawnedProcessEvent {
    id: IdType,
    kind: SpawnedProcessEventKind,
}

#[derive(Clone, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind",
    content = "data"
)]
enum SpawnedProcessEventKind {
    TokenAssigned,
    LaunchedProcess {
        args: Vec<String>,
    },
    PipeEvent {
        is_initial: bool,
        is_stdout: bool,
        data: Vec<u8>,
    },
    ServerStarted {
        url: String,
        token: String,
    },
    Exited {
        success: bool,
        exit_code: Option<i32>,
    },
}

/// Join strings with spaces, quoting those that contain spaces.
trait SpaceJoin {
    fn space_join(&self) -> String;
}

impl SpaceJoin for Vec<String> {
    fn space_join(&self) -> String {
        let mut parts = vec![];
        for s in self {
            if s.contains(' ') {
                parts.push(format!("\"{s}\""));
            } else {
                parts.push(s.to_string());
            }
        }
        parts.join(" ")
    }
}

#[derive(Clone)]
struct UvInfo {
    version: String,
    setup: String,
    launch: String,
}

fn get_uv_info(app: &tauri::AppHandle) -> eyre::Result<UvInfo> {
    let sidecar_uv = app.shell().sidecar("uv")?;
    let sidecar_command = sidecar_uv.args(["--version"]);
    let mut std_command: std::process::Command = sidecar_command.into();
    let output = std_command
        .output()
        .with_context(|| format!("executing sidecar uv command: {std_command:?}"))?; // If sidecar uv is missing, this will panic.
    if output.status.success() {
        let version = String::from_utf8(output.stdout).unwrap();
        let setup = format!(
            "uv {} && uv {}",
            sync_args("<project_dir>").space_join(),
            report_python_args("<project_dir>").space_join(),
        );
        let launch =
            "uv ".to_owned() + &run_jlab_args("<project_dir>", "<port>", "<token>").space_join();
        Ok(UvInfo {
            version,
            setup,
            launch,
        })
    } else {
        Err(eyre::eyre!("Failed to get uv version"))
    }
}

#[tauri::command]
fn uv_version_setup_launch(state: State<'_, Mutex<AppState>>) -> (String, String, String) {
    let uv_info = {
        let state = state.lock().unwrap();
        state.uv_info.clone()
    };
    (uv_info.version, uv_info.setup, uv_info.launch)
}

#[tauri::command]
fn get_cwd(app: tauri::AppHandle) -> String {
    let store = app.store("store.json").unwrap();
    if let Some(value) = store.get("workingDir") {
        tracing::debug!("loaded from store: workingDir: {value}");
        value.as_str().unwrap().to_string()
    } else {
        panic!("workingDir not found in store");
    }
}

#[tauri::command]
fn set_cwd(app: tauri::AppHandle, cwd: String) {
    let store = app.store("store.json").unwrap();
    store.set("workingDir", serde_json::json!(cwd));
    tracing::debug!("stored to store: workingDir: {cwd}");
}

#[tauri::command]
fn get_package_config(app: tauri::AppHandle) -> PackageConfig {
    let store = app.store("store.json").unwrap();
    if let Some(value) = store.get("packageConfig") {
        tracing::debug!("loaded from store: packageConfig: {value}");

        // Try to deserialize as new format first
        if let Ok(config) = serde_json::from_value::<PackageConfig>(value.clone()) {
            return config;
        }

        tracing::error!("Failed to deserialize packageConfig");
    } else {
        tracing::error!("packageConfig not found in store");
    }

    // If all else fails, return default
    let cfg = Default::default();
    store.set("packageConfig", serde_json::json!(cfg));
    tracing::debug!("stored default to store: packageConfig");
    cfg
}

#[tauri::command]
fn set_package_config(app: tauri::AppHandle, package_config: PackageConfig) {
    let store = app.store("store.json").unwrap();
    store.set("packageConfig", serde_json::json!(package_config));
    tracing::debug!("stored to store: packageConfig");
}

#[tauri::command]
fn parse_pyproject_toml(content: String) -> Result<ParsedPyproject, String> {
    // Parse TOML using serde
    let parsed: toml::Value =
        toml::from_str(&content).map_err(|e| format!("Failed to parse TOML: {}", e))?;

    let project = parsed
        .get("project")
        .ok_or_else(|| "Could not find [project] section in pyproject.toml".to_string())?;

    // Extract Python version from requires-python if present
    let python_version = project
        .get("requires-python")
        .and_then(|v| v.as_str().map(Into::into));

    // Navigate to project.dependencies
    let dependencies = project
        .get("dependencies")
        .and_then(|d| d.as_array())
        .ok_or_else(|| {
            "Could not find [project] dependencies array in pyproject.toml".to_string()
        })?;

    let mut packages = Vec::new();

    for dep in dependencies {
        let dep_str = dep
            .as_str()
            .ok_or_else(|| "Dependency is not a string".to_string())?;

        // Parse dependency string (e.g., "numpy>=1.0.0" or "pandas")
        let dep_str = dep_str.trim();

        // Skip empty strings and comments
        if dep_str.is_empty() || dep_str.starts_with('#') {
            continue;
        }

        // Split on common version specifiers
        let name_version: Vec<&str> = dep_str.split(&['=', '>', '<', '~', '!'][..]).collect();

        let name = name_version[0].trim().to_string();

        // Extract version if present
        let version = if dep_str.contains(['=', '>', '<', '~']) {
            // Find the version part after the operator
            let version_part = dep_str
                .split_once(['=', '>', '<', '~'])
                .and_then(|(_, v)| {
                    let v = v.trim_start_matches(['=', '>', '<', '~']);
                    let v = v.trim();
                    if v.is_empty() {
                        None
                    } else {
                        Some(v.to_string())
                    }
                });
            version_part
        } else {
            None
        };

        packages.push(PackageInfo {
            name,
            version,
            desc: None,
            url: None,
            source: "imported".to_string(),
            selected: true,
        });
    }

    if packages.is_empty() {
        return Err("No packages found in pyproject.toml".to_string());
    }

    Ok(ParsedPyproject {
        python_version,
        packages,
    })
}

#[tauri::command]
fn process_group_state(state: State<'_, Mutex<AppState>>, id: IdType) -> Option<PGState> {
    let mut state = state.lock().unwrap();

    let (new_state, result) = if let Some(old_state) = state.children.remove(&id) {
        match old_state {
            SpawnedProcessState::TokenAssigned => (
                SpawnedProcessState::TokenAssigned,
                Some(PGState::TokenAssigned),
            ),
            SpawnedProcessState::ThreadSpawned { join_handle } => {
                if join_handle.is_finished() {
                    return Some(PGState::Exited);
                }
                (
                    SpawnedProcessState::ThreadSpawned { join_handle },
                    Some(PGState::ThreadSpawned),
                )
            }
            SpawnedProcessState::Running { join_handle, child } => {
                if join_handle.is_finished() {
                    return Some(PGState::Exited);
                }
                (
                    SpawnedProcessState::Running { join_handle, child },
                    Some(PGState::Running),
                )
            }
            SpawnedProcessState::Exited { status } => (
                SpawnedProcessState::Exited { status },
                Some(PGState::Exited),
            ),
        }
    } else {
        tracing::error!("No such child: {id}");
        return None;
    };
    state.children.insert(id, new_state);
    result
}

#[tauri::command]
fn kill_process_group(state: State<'_, Mutex<AppState>>, id: IdType) {
    let mut state = state.lock().unwrap();

    let _join_handle = if let Some(mut child) = state.children.remove(&id) {
        match child {
            SpawnedProcessState::TokenAssigned => {
                todo!();
                // tracing::error!("Process group {id} was started but not running yet");
                // TODO: stop the spawning thread?
            }
            SpawnedProcessState::ThreadSpawned { join_handle } => {
                if true {
                    todo!("how to kill not-yet-started process?");
                }
                join_handle
            }
            SpawnedProcessState::Running {
                ref mut child,
                join_handle,
            } => {
                tracing::info!("Killing process group {id}");
                child.start_kill().unwrap();
                join_handle
            }
            SpawnedProcessState::Exited { .. } => {
                tracing::warn!("Process group {id} has already exited");
                return;
            }
        }
    } else {
        tracing::error!("No such child: {id}");
        return;
    };

    // TODO: fix waiting for process to exit...
    // tracing::info!("Waiting for process group {id} to exit");
    // join_handle.join().unwrap().unwrap();
    // tracing::info!("Process group {id} has exited");
}

/// Pick a free TCP port on localhost by binding to port 0 and reading back the
/// assigned port. The listener is closed immediately, so there is a small race
/// window before Jupyter binds the port, but this is acceptable in practice.
fn pick_free_port() -> eyre::Result<u16> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    Ok(port)
}

trait ReadExt: std::io::Read + Send + 'static {}
impl ReadExt for std::process::ChildStdout {}
impl ReadExt for std::process::ChildStderr {}

fn spawn_sender(
    is_initial: bool,
    mut src: impl ReadExt,
    is_stdout: bool,
    id: IdType,
    channel: Channel<SpawnedProcessEvent>,
) {
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 8192]; // Pre-allocate buffer with 8KB capacity
        loop {
            let n_bytes = std::io::Read::read(&mut src, &mut buf).unwrap();
            if n_bytes == 0 {
                break;
            }
            channel
                .send(SpawnedProcessEvent {
                    id,
                    kind: SpawnedProcessEventKind::PipeEvent {
                        is_initial,
                        is_stdout,
                        data: buf[..n_bytes].to_vec(),
                    },
                })
                .unwrap();
        }
    });
}

/// Immediately spawn a thread which itself spawns jupyter using uv.
///
/// By returning immediatedly, we avoid blocking the Tauri event loop. Updates,
/// e.g. for the UI, are given over the channel.
#[tauri::command]
fn spawn_uv(
    app: tauri::AppHandle,
    pyproject_config: String,
    working_dir: String,
    channel: Channel<SpawnedProcessEvent>,
) {
    // Assign an ID for this spawned process.
    let state = app.state::<Mutex<AppState>>();
    let id = {
        let mut state = state.lock().unwrap();
        let id = state.next_id;
        state.next_id += 1;
        state
            .children
            .insert(id, SpawnedProcessState::TokenAssigned);
        id
    };

    // Notify caller that the process has started and give it the ID.
    channel
        .send(SpawnedProcessEvent {
            id,
            kind: SpawnedProcessEventKind::TokenAssigned,
        })
        .unwrap();

    // Spawn a new thread to do the actual spawning.
    let app2 = app.clone();
    let join_handle = std::thread::spawn(move || -> eyre::Result<()> {
        uv_mainloop(id, app2, pyproject_config, working_dir.into(), channel)
    });

    {
        let mut state = state.lock().unwrap();
        let x = state.children.get_mut(&id).unwrap();
        *x = SpawnedProcessState::ThreadSpawned { join_handle };
    }
}

fn spawn_process(
    sidecar_command: tauri_plugin_shell::process::Command,
    pipe_output: bool,
) -> eyre::Result<Box<dyn process_wrap::std::ChildWrapper>> {
    use process_wrap::std::*;

    let mut std_command: std::process::Command = sidecar_command.into();

    if pipe_output {
        std_command
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
    } else {
        std_command
            .stdout(std::io::stdout())
            .stderr(std::io::stderr());
    }

    let mut command = CommandWrap::from(std_command);

    // Wrap so that child.kill() will kill the whole process group. This is
    // necessary because uv will terminate immediately after launching jupyter
    // and without wrapping, "killing" (the already terminated) uv process
    // wouldn't kill jupyter.
    #[cfg(unix)]
    {
        command.wrap(ProcessGroup::leader());
    }
    #[cfg(windows)]
    {
        command.wrap(JobObject);
    }

    let child = command.spawn()?;

    Ok(child)
}

/// Run a setup uv command to completion, piping its stdout/stderr to the
/// frontend as initial output. Bails if the command exits unsuccessfully.
fn run_initial_uv_step(
    app: &tauri::AppHandle,
    cwd: &camino::Utf8Path,
    args: Vec<String>,
    id: IdType,
    channel: &Channel<SpawnedProcessEvent>,
) -> eyre::Result<()> {
    let sidecar_command = app.shell().sidecar("uv")?.current_dir(cwd).args(&args);
    let mut child = spawn_process(sidecar_command, true)?;

    channel
        .send(SpawnedProcessEvent {
            id,
            kind: SpawnedProcessEventKind::LaunchedProcess { args },
        })
        .unwrap();

    let stdout = child.stdout().take().unwrap();
    spawn_sender(true, stdout, true, id, channel.clone());

    let stderr = child.stderr().take().unwrap();
    spawn_sender(true, stderr, false, id, channel.clone());

    if !child.wait()?.success() {
        eyre::bail!("uv setup step failed");
    }
    Ok(())
}

/// Spawn jupyter using normal rust error handling.
///
/// This function runs in a newly created thread.
fn uv_mainloop(
    id: IdType,
    app: tauri::AppHandle,
    pyproject_config: String,
    cwd: camino::Utf8PathBuf,
    channel: Channel<SpawnedProcessEvent>,
) -> eyre::Result<()> {
    // use process_wrap::std::*;

    // Create pyproject.toml in temporary directory.
    let temp_dir = tempfile::tempdir()?;
    // temp_dir.disable_cleanup(true); // TODO: remove this line when done debugging
    // tracing::warn!("temp dir not being deleted: {temp_dir_path}");
    let temp_dir_path = camino::Utf8PathBuf::from_path_buf(temp_dir.path().to_path_buf())
        .map_err(|_| eyre::eyre!("temp dir path is not valid UTF-8"))?;
    tracing::debug!("temp dir path: {temp_dir_path}");

    let pyproject_path = temp_dir_path.join("pyproject.toml");
    std::fs::write(&pyproject_path, pyproject_config)?;

    // Set up the ephemeral project: first `uv sync` to materialize the virtual
    // environment, then run the interpreter once to confirm it executes and to
    // report its path/version to the UI.
    tracing::info!("setting up uv environment in working dir: {cwd}");
    run_initial_uv_step(&app, &cwd, sync_args(temp_dir_path.as_str()), id, &channel)?;
    run_initial_uv_step(
        &app,
        &cwd,
        report_python_args(temp_dir_path.as_str()),
        id,
        &channel,
    )?;
    tracing::info!("uv setup completed successfully");

    // Spawn uv to run jupyter lab. We choose the port and token ourselves and
    // pass them to Jupyter, rather than launching Jupyter and then discovering
    // them via `jupyter server list`. This avoids the inherent race in diffing
    // the server list and means we know the server URL before it even starts.

    let port = pick_free_port()?;
    let token = uuid::Uuid::new_v4().simple().to_string();
    let server_url = format!("http://localhost:{port}/");

    tracing::info!("spawning uv in working dir: {cwd}");

    let args = run_jlab_args(temp_dir_path.as_str(), &port.to_string(), &token);
    let sidecar_command = app.shell().sidecar("uv")?.current_dir(cwd).args(&args);

    let mut child = spawn_process(sidecar_command, true)?;

    channel
        .send(SpawnedProcessEvent {
            id,
            kind: SpawnedProcessEventKind::LaunchedProcess {
                args: args.into_iter().collect(),
            },
        })
        .unwrap();

    let stdout = child.stdout().take().unwrap();
    spawn_sender(false, stdout, true, id, channel.clone());

    let stderr = child.stderr().take().unwrap();
    spawn_sender(false, stderr, false, id, channel.clone());

    let state = app.state::<Mutex<AppState>>();
    {
        let mut state = state.lock().unwrap();
        let old_state = state.children.remove(&id).unwrap();
        let join_handle = match old_state {
            SpawnedProcessState::ThreadSpawned { join_handle } => join_handle,
            _ => panic!("unexpected state for process group {id}"),
        };
        state
            .children
            .insert(id, SpawnedProcessState::Running { join_handle, child });
    };
    tracing::info!("Spawned process group {id}");

    // Wait for the jupyter server to start listening on the port we assigned.
    // A successful TCP connection means the server is accepting connections.
    // Guard against waiting forever: give up if jupyter exits before binding the
    // port, if the process group is killed, or if a startup deadline elapses.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
    let state = app.state::<Mutex<AppState>>();
    loop {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            break;
        }

        let timed_out = std::time::Instant::now() >= deadline;
        {
            let mut state = state.lock().unwrap();
            match state.children.get_mut(&id) {
                Some(SpawnedProcessState::Running { child, .. }) => {
                    // If jupyter exited before binding the port, report it and stop.
                    if let Some(status) = child.try_wait()? {
                        channel
                            .send(SpawnedProcessEvent {
                                id,
                                kind: SpawnedProcessEventKind::Exited {
                                    success: false,
                                    exit_code: status.code(),
                                },
                            })
                            .unwrap();
                        eyre::bail!("jupyter exited (status: {status}) before its server started");
                    }
                    // Still running but out of time: kill it and report failure.
                    if timed_out {
                        if let Err(e) = child.start_kill() {
                            tracing::error!("failed to kill timed-out jupyter process: {e}");
                        }
                        channel
                            .send(SpawnedProcessEvent {
                                id,
                                kind: SpawnedProcessEventKind::Exited {
                                    success: false,
                                    exit_code: None,
                                },
                            })
                            .unwrap();
                        eyre::bail!("timed out waiting for jupyter server on port {port}");
                    }
                }
                // The process group was killed or removed elsewhere; stop waiting.
                _ => {
                    tracing::info!("process group {id} no longer running, stop waiting");
                    return Ok(());
                }
            }
        }

        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    channel
        .send(SpawnedProcessEvent {
            id,
            kind: SpawnedProcessEventKind::ServerStarted {
                url: server_url,
                token,
            },
        })
        .unwrap();

    // Now loop until the child stops. (TODO: why not just block on
    // child.wait()? My initial answer is that then we need to keep the lock on
    // AppState. Probably we could re-jig things that this is not needed.)
    let state = app.state::<Mutex<AppState>>();
    loop {
        let mut is_done = false;
        {
            let mut state = state.lock().unwrap();
            let mut old_state = match state.children.remove(&id) {
                Some(s) => s,
                None => {
                    tracing::info!("Process group {id} no longer in state, assuming killed");
                    break;
                }
            };
            let new_state = match &mut old_state {
                SpawnedProcessState::Running { ref mut child, .. } => match child.try_wait()? {
                    Some(status) => {
                        let pid = child.id();
                        tracing::info!(
                            "Process group {id} (pid: {pid})exited with status: {status}",
                        );
                        is_done = true;

                        channel
                            .send(SpawnedProcessEvent {
                                id,
                                kind: SpawnedProcessEventKind::Exited {
                                    success: status.success(),
                                    exit_code: status.code(),
                                },
                            })
                            .unwrap();
                        SpawnedProcessState::Exited { status }
                    }
                    None => old_state,
                },
                _ => {
                    panic!("unexpected state for process group {id}");
                }
            };
            state.children.insert(id, new_state);
        };
        if is_done {
            break;
        } else {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }

    Ok(())
}

/// `uv sync` resolves the dependencies and materializes the virtual environment
/// for the ephemeral project. Since the generated pyproject.toml has no
/// [build-system], uv treats it as a virtual (non-package) project and only
/// installs the dependencies.
fn sync_args(project_dir: &str) -> Vec<String> {
    ["sync", "--no-config", "--project", project_dir]
        .into_iter()
        .map(Into::into)
        .collect()
}

/// Run the project interpreter once to confirm it actually executes and to
/// report its path and version to the UI.
fn report_python_args(project_dir: &str) -> Vec<String> {
    [
        "run",
        "--no-config",
        "--project",
        project_dir,
        "python",
        "-c",
        "import sys; print(sys.executable, sys.version)",
    ]
    .into_iter()
    .map(Into::into)
    .collect()
}

fn run_jlab_args(project_dir: &str, port: &str, token: &str) -> Vec<String> {
    vec![
        "run".to_string(),
        "--no-config".to_string(),
        "--project".to_string(),
        project_dir.to_string(),
        "jupyter".to_string(),
        "lab".to_string(),
        format!("--ServerApp.port={port}"),
        // Token moved to IdentityProvider in Jupyter Server 2.0; ServerApp.token
        // is deprecated.
        format!("--IdentityProvider.token={token}"),
    ]
}

/// Version of the on-disk `store.json` layout. Bump this whenever the store's
/// schema changes in a way that old data can't be read as-is. On startup a
/// store whose `schemaVersion` is missing or different is discarded and
/// regenerated from defaults (see `migrate_store`).
const STORE_SCHEMA_VERSION: u64 = 1;

/// Bring the persisted store up to the current [`STORE_SCHEMA_VERSION`],
/// preserving the user's existing data.
///
/// `default_working_dir` is the directory used to repair a legacy working
/// directory of `/` (see the `workingDir` default in `run`).
///
/// Migrations are applied step by step so an old store is upgraded through
/// each intermediate version. Add a new arm here whenever
/// [`STORE_SCHEMA_VERSION`] is bumped.
fn migrate_store<R: tauri::Runtime>(
    store: &tauri_plugin_store::Store<R>,
    default_working_dir: &str,
) {
    loop {
        // Stores written before versioning existed have no `schemaVersion`.
        let current = store.get("schemaVersion").and_then(|v| v.as_u64());
        match current {
            Some(v) if v == STORE_SCHEMA_VERSION => {
                tracing::debug!("store schema up to date (v{STORE_SCHEMA_VERSION})");
                return;
            }
            None => {
                // Legacy (unversioned) -> v1. Keep all existing data, but fix a
                // working directory of `/` (the old macOS-from-Finder default)
                // by pointing it at the home directory instead.
                let is_root_cwd = store
                    .get("workingDir")
                    .and_then(|v| v.as_str().map(str::to_owned))
                    .as_deref()
                    == Some("/");
                if is_root_cwd {
                    tracing::info!("migrating legacy workingDir `/` -> {default_working_dir}");
                    store.set("workingDir", serde_json::json!(default_working_dir));
                }
                store.set("schemaVersion", serde_json::json!(1u64));
                tracing::debug!("migrated store schema: (none) -> v1");
            }
            Some(v) => {
                // Newer than we understand (e.g. written by a future build).
                // Leave the data untouched rather than risk corrupting it.
                tracing::warn!(
                    "store schema version {v} is newer than supported {STORE_SCHEMA_VERSION}; leaving as-is",
                );
                return;
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            let store = app.store("store.json")?;

            // The default working directory is the user's home directory. When
            // the app is launched from Finder on macOS the process cwd is `/`,
            // which is a poor default, so we prefer the home dir and only fall
            // back to the cwd if the home dir can't be determined. This is used
            // both for a fresh store and to repair a legacy `/` during migration.
            let default_working_dir = app
                .path()
                .home_dir()
                .unwrap_or_else(|_| std::env::current_dir().unwrap())
                .into_os_string()
                .into_string()
                .unwrap();

            // Upgrade the store to the current schema version, preserving user
            // data, before we read or populate any defaults below.
            migrate_store(&store, &default_working_dir);

            // // Note that values must be serde_json::Value instances,
            // // otherwise, they will not be compatible with the JavaScript bindings.
            // store.set("some-key", json!({ "value": 5 }));

            // Get a value from the store.
            if let Some(value) = store.get("workingDir") {
                tracing::debug!("loaded from store: workingDir: {value}");
            } else {
                tracing::debug!("defaulting workingDir: {default_working_dir}");
                store.set("workingDir", serde_json::json!(default_working_dir));
                tracing::debug!("stored to store: workingDir: {default_working_dir}");
            }

            let uv_info = get_uv_info(app.handle()).unwrap();
            app.manage(Mutex::new(AppState {
                uv_info,
                next_id: Default::default(),
                children: Default::default(),
            }));
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            uv_version_setup_launch,
            get_cwd,
            set_cwd,
            get_package_config,
            set_package_config,
            parse_pyproject_toml,
            process_group_state,
            kill_process_group,
            spawn_uv
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // This never returns but calls std::process::exit() directly.
    app.run(|app_handle, event| if let tauri::RunEvent::ExitRequested { .. } = event {
        // So this doesn't work on macOS when the user presses Cmd-Q. See
        // https://github.com/tauri-apps/tauri/issues/9198 and
        // https://github.com/tauri-apps/tauri/issues/12978 .
        tracing::info!("Exit requested, cleaning up child processes...");
        let state = app_handle.state::<Mutex<AppState>>();
        let mut state = state.lock().unwrap();
        for (id, child) in state.children.drain() {
            let join_handle = match child {
                SpawnedProcessState::TokenAssigned => {
                    todo!();
                }
                SpawnedProcessState::ThreadSpawned { join_handle } => {
                    if true {
                        todo!("how to kill not-yet-started process?");
                    }
                    join_handle
                    // join_handle.abort();
                    // tracing::info!("Killed spawning thread for process group {id}");
                }
                SpawnedProcessState::Running {
                    mut child,
                    join_handle,
                } => {
                    let pid = child.id();
                    tracing::info!("Killing process group {id} (pid: {pid})");
                    if let Err(e) = child.kill() {
                        tracing::error!("Failed to kill process group {id} (pid: {pid}): {e}");
                    }
                    join_handle
                }
                SpawnedProcessState::Exited { .. } => {
                    tracing::info!("Process group {id} has already exited");
                    continue;
                }
            };
            join_handle.join().unwrap().unwrap();
        }
    });
}
