import { useState, useEffect, useRef } from "react";
import { Sun, Package, Play, FolderOpen, Check, Copy, Loader2, ChevronDown, ChevronUp, ExternalLink, Eye, Upload, AlertCircle, CheckCircle } from 'lucide-react';

import { invoke, Channel } from "@tauri-apps/api/core";
import "./App.css";
import { open } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';

type SpawnedProcessEvent = {
  id: number;
  kind: SpawnedProcessEventKind;
}

type SpawnedProcessEventKind =
  | {
    kind: 'tokenAssigned';
  }
  | {
    kind: 'launchedProcess';
    data: {
      args: string[];
    };
  }
  | {
    kind: 'pipeEvent';
    data: {
      isInitial: boolean;
      isStdout: boolean;
      data: Uint8Array;
    };
  }
  | {
    kind: 'serverStarted';
    data: {
      url: string;
      token: string;
    };
  }
  | {
    kind: 'exited';
    data: {
      success: boolean;
      exitCode: number | null;
    };
  };


type PackageInfo = {
  name: string;
  version?: string;
  desc: string;
  url?: string;
  source: 'popular' | 'custom' | 'imported';
  selected: boolean;
};

type PackageConfig = {
  pythonVersion: string;
  packages: PackageInfo[];  // Flattened list for storage
};

function pyproject_contents(packages: PackageInfo[], pythonVersion: string): string {
  // Filter to get only selected packages - jupyterlab will always be selected
  const selectedPackages = packages.filter(p => p.selected);

  const deps = selectedPackages.map(pkg => {
    if (pkg.version) {
      return `    "${pkg.name}==${pkg.version}"`;
    }
    return `    "${pkg.name}"`;
  }).join(",\n");

  // If pythonVersion doesn't start with a version specifier (==, >=, <=, ~=, etc.), prepend "=="
  const versionSpec = /^[=<>~!]/.test(pythonVersion) ? pythonVersion : `==${pythonVersion}`;

  return `[project]
name = "sunbeam-ephemeral-project"
requires-python = "${versionSpec}"
version = "0.1.0"
dependencies = [
${deps}
]
`;
}

function LaunchModal({
  isOpen,
  serverUrl,
  serverToken,
  outputLines,
  processId,
  onClose,
}: {
  isOpen: boolean;
  serverUrl: string | null;
  serverToken: string | null;
  outputLines: Array<{ type: 'args' | 'stdout' | 'stderr', content: string }>;
  processId: number | null;
  onClose: () => void;
}) {
  const [showOutput, setShowOutput] = useState(true);
  const [showCopiedTooltip, setShowCopiedTooltip] = useState(false);
  const [showShutdownConfirm, setShowShutdownConfirm] = useState(false);
  const [processExited, setProcessExited] = useState(false);
  const outputEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll output to bottom when new lines are added
  useEffect(() => {
    if (showOutput && outputEndRef.current) {
      outputEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [outputLines, showOutput]);

  // Poll process state every 200ms
  useEffect(() => {
    if (!isOpen || processId === null) {
      setProcessExited(false);
      return;
    }

    const intervalId = setInterval(async () => {
      try {
        const result = await invoke<{ state: string }>("process_group_state", { id: processId });
        console.log("Polled process state:", result);
        if (result.state === "exited") {
          setProcessExited(true);
          clearInterval(intervalId);
        }
      } catch (error) {
        console.error("Failed to get process state:", error);
      }
    }, 200);

    return () => clearInterval(intervalId);
  }, [isOpen, processId]);

  if (!isOpen) return null;

  const fullUrl = serverUrl && serverToken ? `${serverUrl}?token=${serverToken}` : null;

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setShowCopiedTooltip(true);
      setTimeout(() => setShowCopiedTooltip(false), 2000);
    } catch (err) {
      console.error('Failed to copy: ', err);
    }
  };

  const handleShutdown = async () => {
    if (processId !== null) {
      await invoke("kill_process_group", { id: processId });
      setShowShutdownConfirm(false);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      {/* Shutdown Confirmation Dialog */}
      {showShutdownConfirm && (
        <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6">
            <h3 className="text-xl font-bold text-gray-800 mb-4">Confirm Shutdown</h3>
            <p className="text-gray-600 mb-4">
              Are you sure you want to shutdown Jupyter Lab? Any unsaved work will be lost.
            </p>
            <p className="text-sm text-gray-500 mb-6">
              Note: You can also shutdown Jupyter Lab from within the Jupyter Lab interface itself by clicking "File" &gt; "Shut Down".
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowShutdownConfirm(false)}
                className="flex-1 px-4 py-2 bg-gray-200 hover:bg-gray-300 rounded-lg font-medium transition"
                title="Keep Jupyter Lab running"
              >
                Cancel
              </button>
              <button
                onClick={handleShutdown}
                className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg font-bold transition"
                title="Stop the Jupyter Lab server"
              >
                Yes, shutdown Jupyter Lab
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[80vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className={`p-6 ${processExited ? 'bg-gradient-to-r from-gray-500 to-gray-600' : 'bg-gradient-to-r from-amber-500 to-orange-500'}`}>
          <h2 className="text-2xl font-bold text-white">
            Jupyter Lab {processExited && '(Process Exited)'}
          </h2>
        </div>

        {/* Content */}
        <div className="p-6 flex-1 overflow-y-auto">
          {processExited && (
            <div className="mb-4 bg-yellow-50 border-2 border-yellow-200 rounded-xl p-4">
              <p className="text-sm font-semibold text-yellow-800">
                ⚠️ The Jupyter Lab process has exited
              </p>
              <p className="text-xs text-yellow-700 mt-1">
                The server is no longer running. Check the output below for error messages.
              </p>
            </div>
          )}

          {!fullUrl ? (
            // Spinner while waiting - now also shows initial output
            <div className="flex flex-col py-12">
              {!processExited && (
                <div className="flex flex-col items-center justify-center mb-6">
                  <Loader2 className="w-16 h-16 text-amber-500 animate-spin mb-4" />
                  <p className="text-gray-600 font-medium">Starting Jupyter Lab...</p>
                  <p className="text-sm text-gray-500 mt-2">This may take a moment</p>
                </div>
              )}

              {/* Show initial output while starting */}
              {outputLines.length > 0 && (
                <div className="border-2 border-gray-200 rounded-xl overflow-hidden">
                  <div className="px-4 py-3 bg-gray-50">
                    <span className="font-semibold text-gray-700">Startup Output</span>
                  </div>
                  <div className="p-4 bg-gray-900 font-mono text-xs max-h-64 overflow-y-auto">
                    {outputLines.map((line, idx) => (
                      <div key={idx}>
                        {line.type === 'args' ? (
                          <div className="text-blue-400 mb-1">
                            $ uv {line.content}
                          </div>
                        ) : (
                          <pre className={`whitespace-pre-wrap break-all ${line.type === 'stdout' ? 'text-gray-300' : 'text-red-300'
                            }`}>{line.content}</pre>
                        )}
                      </div>
                    ))}
                    <div ref={outputEndRef} />
                  </div>
                </div>
              )}

              {/* Close button when process exited */}
              {processExited && (
                <div className="flex justify-end mt-4">
                  <button
                    onClick={onClose}
                    className="px-6 py-2 bg-gray-600 hover:bg-gray-700 text-white rounded-lg font-medium transition"
                    title="Close this dialog"
                  >
                    Close
                  </button>
                </div>
              )}
            </div>
          ) : (
            // URL display when ready
            <div className="space-y-4">
              <div className="bg-green-50 border-2 border-green-200 rounded-xl p-4">
                <p className="text-sm font-semibold text-green-800 mb-2">Jupyter Lab is ready!</p>
                <div className="bg-white rounded-lg p-3 font-mono text-sm break-all">
                  {fullUrl}
                </div>
                <div className="flex gap-2 mt-3">
                  <button
                    onClick={() => openUrl(fullUrl)}
                    className="flex-1 px-4 py-2 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white rounded-lg font-medium transition flex items-center justify-center gap-2"
                    title="Open Jupyter Lab in your default browser"
                  >
                    <ExternalLink className="w-4 h-4" />
                    Open in Browser
                  </button>
                  <button
                    onClick={() => copyToClipboard(fullUrl)}
                    className="px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg font-medium transition flex items-center gap-2"
                    title="Copy URL to clipboard"
                  >
                    <Copy className="w-4 h-4" />
                    Copy
                    {showCopiedTooltip && (
                      <span className="text-sm text-green-600 font-semibold">✓</span>
                    )}
                  </button>
                </div>
              </div>

              {/* Combined Output section */}
              <div className="border-2 border-gray-200 rounded-xl overflow-hidden">
                <button
                  onClick={() => setShowOutput(!showOutput)}
                  className="w-full px-4 py-3 bg-gray-50 hover:bg-gray-100 transition flex items-center justify-between"
                  title={showOutput ? "Hide process output" : "Show process output (stdout and stderr)"}
                >
                  <span className="font-semibold text-gray-700">Process Output</span>
                  {showOutput ? (
                    <ChevronUp className="w-5 h-5 text-gray-600" />
                  ) : (
                    <ChevronDown className="w-5 h-5 text-gray-600" />
                  )}
                </button>
                {showOutput && (
                  <div className="p-4 bg-gray-900 font-mono text-xs max-h-64 overflow-y-auto">
                    {outputLines.length > 0 ? (
                      <>
                        {outputLines.map((line, idx) => (
                          <div key={idx}>
                            {line.type === 'args' ? (
                              <div className="text-blue-400 mb-1">
                                $ uv {line.content}
                              </div>
                            ) : (
                              <pre className={`whitespace-pre-wrap break-all ${line.type === 'stdout' ? 'text-gray-300' : 'text-red-300'
                                }`}>{line.content}</pre>
                            )}
                          </div>
                        ))}
                        <div ref={outputEndRef} />
                      </>
                    ) : (
                      <div className="text-gray-500">(no output yet)</div>
                    )}
                  </div>
                )}
              </div>

              {/* Shutdown Button */}
              <div className="flex justify-end">
                {processExited ? (
                  <button
                    onClick={onClose}
                    className="px-6 py-2 bg-gray-600 hover:bg-gray-700 text-white rounded-lg font-medium transition"
                    title="Close this dialog"
                  >
                    Close
                  </button>
                ) : (
                  <button
                    onClick={() => setShowShutdownConfirm(true)}
                    className="px-6 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg font-medium transition"
                    title="Stop the Jupyter Lab server process"
                  >
                    Shutdown Jupyter Lab
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PreviewModal({
  isOpen,
  workingDir,
  pyprojectContent,
  onClose,
  onLaunch,
}: {
  isOpen: boolean;
  workingDir: string;
  pyprojectContent: string;
  onClose: () => void;
  onLaunch: () => void;
}) {
  const [uvVersion, setUvVersion] = useState<string>('');
  const [setupCommand, setSetupCommand] = useState<string>('');
  const [launchCommand, setLaunchCommand] = useState<string>('');

  useEffect(() => {
    if (isOpen) {
      invoke<[string, string, string]>("uv_version_setup_launch").then(([version, setup, launch]) => {
        setUvVersion(version.trim());
        setSetupCommand(setup.trim());
        setLaunchCommand(launch.trim());
      }).catch(err => {
        console.error('Failed to get uv info:', err);
        setUvVersion('Unknown');
        setSetupCommand('Unknown');
        setLaunchCommand('Unknown');
      });
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      console.error('Failed to copy: ', err);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-3xl w-full max-h-[80vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="bg-gradient-to-r from-amber-500 to-orange-500 p-6">
          <h2 className="text-2xl font-bold text-white">Configuration Preview</h2>
        </div>

        {/* Content */}
        <div className="p-6 flex-1 overflow-y-auto space-y-4">
          {/* UV Version */}
          {uvVersion && (
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-2">UV Version:</h3>
              <p className="text-xs text-gray-500 mt-1">
                This is the version of UV bundled with Sunbeam.
              </p>
              <div className="bg-gray-50 border-2 border-gray-200 rounded-lg p-3 font-mono text-sm">
                {uvVersion}
              </div>
            </div>
          )}

          {/* Setup Command */}
          {setupCommand && (
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-2">Setup Command:</h3>
              <div className="bg-gray-50 border-2 border-gray-200 rounded-lg p-3 font-mono text-sm">
                {setupCommand}
              </div>
            </div>
          )}

          {/* Launch Command */}
          {launchCommand && (
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-2">Launch Command:</h3>
              <div className="bg-gray-50 border-2 border-gray-200 rounded-lg p-3 font-mono text-sm">
                {launchCommand}
              </div>
            </div>
          )}

          {/* Working Directory */}
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-2">Working Directory:</h3>
            <div className="bg-gray-50 border-2 border-gray-200 rounded-lg p-3 font-mono text-sm">
              {workingDir}
            </div>
          </div>

          {/* pyproject.toml */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-gray-700">pyproject.toml:</h3>
              <button
                onClick={() => copyToClipboard(pyprojectContent)}
                className="px-3 py-1 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm font-medium transition flex items-center gap-2"
                title="Copy pyproject.toml to clipboard"
              >
                <Copy className="w-4 h-4" />
                Copy
              </button>
            </div>
            <div className="bg-gray-900 text-gray-100 rounded-lg p-4 font-mono text-sm overflow-x-auto">
              <pre className="whitespace-pre">{pyprojectContent}</pre>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="border-t-2 border-gray-200 p-6 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-6 py-2 bg-gray-200 hover:bg-gray-300 text-gray-800 rounded-lg font-semibold transition"
            title="Close preview"
          >
            Close
          </button>
          <button
            onClick={() => {
              onLaunch();
              onClose();
            }}
            className="px-6 py-2 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white rounded-lg font-semibold transition flex items-center gap-2"
            title="Launch Jupyter Lab"
          >
            <Play className="w-5 h-5" />
            Launch Jupyter Lab
          </button>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [pythonVersion, setPythonVersion] = useState("3.13.5");
  const [packages, setPackages] = useState<Map<string, PackageInfo>>(new Map());
  const [configLoaded, setConfigLoaded] = useState(false);

  const [workingDir, setWorkingDir] = useState("");

  // Custom package input state
  const [customPackageName, setCustomPackageName] = useState("");
  const [customPackageVersion, setCustomPackageVersion] = useState("");

  // Modal state
  const [showLaunchModal, setShowLaunchModal] = useState(false);
  const [launchServerUrl, setLaunchServerUrl] = useState<string | null>(null);
  const [launchServerToken, setLaunchServerToken] = useState<string | null>(null);
  const [launchOutputLines, setLaunchOutputLines] = useState<Array<{ type: 'args' | 'stdout' | 'stderr', content: string }>>([]);
  const [launchProcessId, setLaunchProcessId] = useState<number | null>(null);
  const [showPreviewModal, setShowPreviewModal] = useState(false);

  // Upload state
  const [uploadStatus, setUploadStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [uploadMessage, setUploadMessage] = useState<string>('');

  useEffect(() => {
    // Load initial configuration
    Promise.all([
      invoke<string>("get_cwd"),
      invoke<PackageConfig>("get_package_config")
    ]).then(([cwd, config]) => {
      setWorkingDir(cwd);
      setPythonVersion(config.pythonVersion);

      // Convert array to Map
      const packageMap = new Map<string, PackageInfo>();
      config.packages.forEach(pkg => {
        packageMap.set(pkg.name, pkg);
      });

      // Ensure jupyterlab is always present and selected
      if (packageMap.has('jupyterlab')) {
        const jlab = packageMap.get('jupyterlab')!;
        packageMap.set('jupyterlab', { ...jlab, selected: true });
      }

      setPackages(packageMap);
      setConfigLoaded(true);
    });
  }, []);

  // Save configuration whenever it changes
  useEffect(() => {
    if (configLoaded) {
      const packageConfig: PackageConfig = {
        pythonVersion,
        packages: Array.from(packages.values()),
      };
      invoke("set_package_config", { packageConfig });
    }
  }, [configLoaded, pythonVersion, packages]);

  const togglePackage = (pkgName: string) => {
    // Prevent deselecting jupyterlab - it's always required
    if (pkgName === 'jupyterlab') {
      return;
    }

    setPackages(prev => {
      const newMap = new Map(prev);
      const pkg = newMap.get(pkgName);
      if (pkg) {
        newMap.set(pkgName, { ...pkg, selected: !pkg.selected });
      }
      return newMap;
    });
  };

  const addCustomPackage = () => {
    if (!customPackageName.trim()) return;

    const newPackage: PackageInfo = {
      name: customPackageName.trim(),
      version: customPackageVersion.trim() || undefined,
      desc: 'Custom package',
      url: undefined,
      source: 'custom',
      selected: true,
    };

    setPackages(prev => {
      const newMap = new Map(prev);
      newMap.set(newPackage.name, newPackage);
      return newMap;
    });
    setCustomPackageName("");
    setCustomPackageVersion("");
  };

  const removeCustomPackage = (pkgName: string) => {
    // Prevent removing jupyterlab - it's always required
    if (pkgName === 'jupyterlab') {
      return;
    }

    setPackages(prev => {
      const newMap = new Map(prev);
      newMap.delete(pkgName);
      return newMap;
    });
  };

  // Get all packages as array for rendering
  const allPackages = Array.from(packages.values());

  const handleLaunch = async () => {
    // Reset modal state
    setLaunchServerUrl(null);
    setLaunchServerToken(null);
    setLaunchOutputLines([]);
    setLaunchProcessId(null);
    setShowLaunchModal(true);

    // Create a new channel for this launch
    const channel = new Channel<SpawnedProcessEvent>();
    channel.onmessage = (event) => {
      const eventKind = event.kind;

      // Update modal state based on event
      if (eventKind.kind === 'tokenAssigned') {
        setLaunchProcessId(event.id);
      } else if (eventKind.kind === 'launchedProcess') {
        // Add the command line to output
        setLaunchOutputLines(prev => [...prev, {
          type: 'args',
          content: eventKind.data.args.join(' ')
        }]);
      } else if (eventKind.kind === 'pipeEvent') {
        const dataArray = eventKind.data.data;
        // Convert array-like object to Uint8Array if needed
        const uint8Array = dataArray instanceof Uint8Array ? dataArray : new Uint8Array(Object.values(dataArray));
        const text = new TextDecoder().decode(uint8Array);

        // Add to output lines
        setLaunchOutputLines(prev => [...prev, {
          type: eventKind.data.isStdout ? 'stdout' : 'stderr',
          content: text
        }]);
      } else if (eventKind.kind === 'serverStarted') {
        setLaunchServerUrl(eventKind.data.url);
        setLaunchServerToken(eventKind.data.token);
      } else if (eventKind.kind === 'exited') {
        console.log('Process exited, closing modal');
        setShowLaunchModal(false);
      }
    };

    const pyprojectConfig = pyproject_contents(allPackages, pythonVersion);

    await invoke<{ pgroupid: string, url: string, token: string }>("spawn_uv", {
      pyprojectConfig,
      workingDir,
      channel
    });
  };

  const selectWorkingDir = async () => {

    const dirHandle = await open({
      defaultPath: workingDir,
      multiple: false,
      directory: true,
    });

    if (!dirHandle) {
      return;
    }
    await invoke("set_cwd", { cwd: dirHandle });
    setWorkingDir(dirHandle);
  };

  const handleUploadPyproject = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Reset status
    setUploadStatus('idle');
    setUploadMessage('');

    try {
      const content = await file.text();

      // Call backend to parse the pyproject.toml
      const result = await invoke<{ pythonVersion?: string, packages: PackageInfo[] }>("parse_pyproject_toml", { content });

      if (result.packages.length === 0) {
        setUploadStatus('error');
        setUploadMessage('No packages found in pyproject.toml');
      } else {
        // Update Python version if present in the uploaded file
        if (result.pythonVersion) {
          setPythonVersion(result.pythonVersion);
        }

        // Add imported packages to the map
        setPackages(prev => {
          const newMap = new Map(prev);
          result.packages.forEach(pkg => {
            newMap.set(pkg.name, {
              ...pkg,
              desc: pkg.desc || 'Imported from pyproject.toml',
              source: 'imported',
              selected: true,
            });
          });
          return newMap;
        });

        setUploadStatus('success');
        const versionMsg = result.pythonVersion ? ` and Python version ${result.pythonVersion}` : '';
        setUploadMessage(`Successfully imported ${result.packages.length} package(s)${versionMsg} from pyproject.toml`);

        // Clear success message after 5 seconds
        setTimeout(() => {
          setUploadStatus('idle');
          setUploadMessage('');
        }, 5000);
      }

    } catch (error) {
      setUploadStatus('error');
      setUploadMessage(`Failed to parse pyproject.toml: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    // Reset the file input
    event.target.value = '';
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-amber-50 to-orange-50 p-8">
      {/* Launch Modal */}
      <LaunchModal
        isOpen={showLaunchModal}
        serverUrl={launchServerUrl}
        serverToken={launchServerToken}
        outputLines={launchOutputLines}
        processId={launchProcessId}
        onClose={() => setShowLaunchModal(false)}
      />

      {/* Preview Modal */}
      <PreviewModal
        isOpen={showPreviewModal}
        workingDir={workingDir}
        pyprojectContent={pyproject_contents(allPackages, pythonVersion)}
        onClose={() => setShowPreviewModal(false)}
        onLaunch={handleLaunch}
      />

      {/* Header */}
      <div className="max-w-4xl mx-auto mb-8">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-gradient-to-br from-amber-400 to-orange-500 rounded-2xl p-3 shadow-lg">
              <Sun className="w-8 h-8 text-white" />
            </div>
            <div>
              <h1 className="text-3xl font-bold text-gray-800">Sunbeam</h1>
              <p className="text-sm text-gray-600">Simple Jupyter Lab</p>
            </div>
          </div>
        </div>
      </div>

      {/* Project Configuration Card */}
      <div className="max-w-4xl mx-auto bg-white rounded-2xl shadow-2xl overflow-hidden mb-6">
        {/* Title Bar */}
        <div className="bg-gradient-to-r from-amber-500 to-orange-500 px-6 py-4">
          <div className="flex items-center gap-3 text-white">
            <h2 className="text-2xl font-bold">Project Configuration</h2>
          </div>
        </div>

        <div className="p-6">
          <p className="text-sm text-gray-600 mb-4">
            Configuration for the <code className="px-1 py-0.5 bg-gray-100 rounded text-xs font-mono">pyproject.toml</code> file which will be used to launch Jupyter Lab.
          </p>

          {/* Python Version */}
          <div className="mb-4">
            <label className="block text-sm font-semibold text-gray-700 mb-2">
              Python version:
            </label>
            <input
              type="text"
              value={pythonVersion}
              onChange={(e) => {
                const value = e.target.value;
                // Allow version specifiers (==, >=, <=, ~=, !=) or just version numbers
                // Allow partial input while typing - be very permissive
                if (value === '' ||
                  /^(=|>|<|~|!|==|>=|<=|~=|!=)?3?(\.\d{0,3}(\.\d{0,3})?)?$/.test(value)) {
                  setPythonVersion(value);
                }
              }}
              onBlur={(e) => {
                const value = e.target.value;
                // Validate on blur - must be complete version with or without specifier
                // Accept: "3.13.5", "==3.13.5", ">=3.11", etc.
                if (!/^(==|>=|<=|~=|!=|>|<)?3\.\d+(\.\d+)?$/.test(value)) {
                  // Reset to default if invalid
                  setPythonVersion("3.13.5");
                }
              }}
              placeholder="3.13.5 or >=3.11"
              className="w-64 px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-amber-500 focus:outline-none transition font-mono"
              title="Python version with optional specifier (e.g., 3.13.5, >=3.11, ==3.13.5)"
            />
            <p className="text-xs text-gray-500 mt-1">
              Must be Python 3.x or 3.x.y, optionally with specifier (e.g., &gt;=3.11, ==3.13.5)
            </p>
          </div>

          {/* Package List */}
          <div className="mb-4 border-t-2 border-gray-200 pt-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-2">Select packages:</h3>
            <div className="grid grid-cols-2 gap-4">
              {/* Split packages into two columns */}
              {[0, 1].map(colIndex => (
                <div key={colIndex} className="border-2 border-gray-200 rounded-lg overflow-hidden">
                  <div className="divide-y divide-gray-200">
                    {allPackages
                      .filter((_, index) => index % 2 === colIndex)
                      .map(pkg => {
                        const isCustomOrImported = pkg.source === 'custom' || pkg.source === 'imported';
                        const isJupyterlab = pkg.name === 'jupyterlab';
                        return (
                          <div
                            key={pkg.name}
                            onClick={() => togglePackage(pkg.name)}
                            className={`flex items-center px-3 py-1 ${isJupyterlab ? 'cursor-default' : 'cursor-pointer'} transition ${pkg.selected
                              ? 'bg-amber-50 hover:bg-amber-100'
                              : 'hover:bg-gray-50'
                              }`}
                            title={isJupyterlab
                              ? `${pkg.name} is always required${pkg.desc ? ' - ' + pkg.desc : ''}`
                              : `Click to ${pkg.selected ? 'deselect' : 'select'} ${pkg.name}${pkg.desc ? ' - ' + pkg.desc : ''}`
                            }
                          >
                            {/* Checkbox column - fixed width */}
                            <div className="flex items-center justify-center w-5 flex-shrink-0">
                              {pkg.selected ? (
                                <Check className={`w-4 h-4 ${isJupyterlab ? 'text-orange-600' : 'text-amber-600'}`} />
                              ) : (
                                <div className="w-4 h-4" />
                              )}
                            </div>

                            {/* Icon column - fixed width */}
                            <div className="w-5 flex items-center justify-center flex-shrink-0">
                              <Package className={`w-3.5 h-3.5 ${pkg.selected ? (isJupyterlab ? 'text-orange-600' : 'text-amber-600') : 'text-gray-400'
                                }`} />
                            </div>

                            {/* Package name column - fixed width */}
                            <div className="w-32 flex-shrink-0">
                              {pkg.url ? (
                                <span
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openUrl(pkg.url!);
                                  }}
                                  className="font-semibold text-gray-800 text-sm hover:text-amber-600 hover:underline cursor-pointer"
                                  title={`Open ${pkg.name} documentation in browser`}
                                >
                                  {pkg.name}
                                </span>
                              ) : (
                                <span className="font-semibold text-gray-800 text-sm">{pkg.name}</span>
                              )}
                            </div>

                            {/* Version column - fixed width */}
                            <div className="w-20 flex-shrink-0">
                              {pkg.version && (
                                <span className="text-xs text-gray-500 font-mono">v{pkg.version}</span>
                              )}
                            </div>

                            {/* Description column - flexible */}
                            <div className="flex-1 min-w-0 flex items-center justify-between">
                              <span className="text-xs text-gray-600 truncate block">{pkg.desc}</span>
                              {isCustomOrImported && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    removeCustomPackage(pkg.name);
                                  }}
                                  className="ml-2 text-red-500 hover:text-red-700 flex-shrink-0"
                                  title="Remove custom package"
                                >
                                  ✕
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Upload pyproject.toml */}
          <div className="border-t-2 border-gray-200 pt-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-2">Import from pyproject.toml:</h3>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <label className="flex-1">
                  <input
                    type="file"
                    accept=".toml"
                    onChange={handleUploadPyproject}
                    className="hidden"
                    id="pyproject-upload"
                  />
                  <div className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg font-medium transition cursor-pointer flex items-center gap-2 justify-center border-2 border-gray-300 hover:border-gray-400">
                    <Upload className="w-4 h-4" />
                    <span>Choose pyproject.toml file</span>
                  </div>
                </label>
              </div>

              {/* Status message */}
              {uploadStatus !== 'idle' && (
                <div className={`flex items-start gap-2 p-3 rounded-lg ${uploadStatus === 'success'
                  ? 'bg-green-50 border-2 border-green-200'
                  : 'bg-red-50 border-2 border-red-200'
                  }`}>
                  {uploadStatus === 'success' ? (
                    <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                  ) : (
                    <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                  )}
                  <p className={`text-sm ${uploadStatus === 'success' ? 'text-green-800' : 'text-red-800'
                    }`}>
                    {uploadMessage}
                  </p>
                </div>
              )}

              <p className="text-xs text-gray-500">
                Select a <code className="px-1 py-0.5 bg-gray-100 rounded text-xs font-mono">pyproject.toml</code> file to automatically import packages. We'll try to parse the dependencies, but some formats may not be supported.
              </p>
            </div>
          </div>

          {/* Add Custom Package */}
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-2">Add custom package:</h3>
            <div className="flex gap-2">
              <input
                type="text"
                value={customPackageName}
                onChange={(e) => setCustomPackageName(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && addCustomPackage()}
                placeholder="Package name (e.g., requests)"
                className="flex-1 px-3 py-2 border-2 border-gray-200 rounded-lg focus:border-amber-500 focus:outline-none transition text-sm"
                title="Enter a Python package name from PyPI"
              />
              <input
                type="text"
                value={customPackageVersion}
                onChange={(e) => setCustomPackageVersion(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && addCustomPackage()}
                placeholder="Version (optional, e.g., 2.31.0)"
                className="w-48 px-3 py-2 border-2 border-gray-200 rounded-lg focus:border-amber-500 focus:outline-none transition text-sm"
                title="Optionally specify a version number (leave blank for latest)"
              />
              <button
                onClick={addCustomPackage}
                className="px-4 py-2 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white rounded-lg font-medium transition"
                title="Add this package to your environment"
              >
                Add Package
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Launch Card */}
      <div className="max-w-4xl mx-auto bg-white rounded-2xl shadow-2xl overflow-hidden">
        <div className="bg-gradient-to-r from-amber-500 to-orange-500 px-6 py-4">
          <div className="flex items-center gap-3 text-white">
            <h2 className="text-2xl font-bold">Launch</h2>
          </div>
        </div>
        <div className="p-6">
          <p className="text-sm text-gray-600 mb-4">
            Start the Jupyter Lab server using the project configuration <code className="px-1 py-0.5 bg-gray-100 rounded text-xs font-mono">pyproject.toml</code> specified above.
          </p>

          {/* Working Directory */}
          <div className="mb-4">
            <label className="block text-sm font-semibold text-gray-700 mb-2">
              Working directory:
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={workingDir}
                onChange={(e) => setWorkingDir(e.target.value)}
                className="flex-1 px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-amber-500 focus:outline-none transition"
                title="Directory where Jupyter Lab will start (your project folder)"
              />
              <button
                className="px-4 py-3 bg-gray-100 hover:bg-gray-200 rounded-xl transition flex items-center gap-2"
                onClick={selectWorkingDir}
                title="Browse for a folder on your computer"
              >
                <FolderOpen className="w-5 h-5 text-gray-600" />
                <span className="font-medium text-gray-700">Browse</span>
              </button>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex gap-3 justify-end">
            <button
              onClick={() => setShowPreviewModal(true)}
              className="px-6 py-3 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-xl font-semibold transition flex items-center gap-2"
              title="Preview project configuration and command line"
            >
              <Eye className="w-5 h-5" />
              Preview
            </button>
            <button
              onClick={handleLaunch}
              className="px-8 py-3 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white rounded-xl font-bold shadow-lg transition flex items-center gap-2"
              title="Start Jupyter Lab with selected packages in the working directory"
            >
              <Play className="w-5 h-6" />
              Launch Jupyter Lab
            </button>
          </div>
        </div>
      </div>

      {/* Footer Info */}
      <div className="max-w-4xl mx-auto mt-6 text-center">
        <p className="text-sm text-gray-600">
          Project management by <span onClick={() => openUrl('https://docs.astral.sh/uv/')} className="font-semibold text-amber-700 cursor-pointer hover:underline">uv</span>, launcher by <span onClick={() => openUrl('https://tauri.app')} className="font-semibold text-amber-700 cursor-pointer hover:underline">Tauri</span>, and Jupyter Lab by <span onClick={() => openUrl('https://jupyter.org')} className="font-semibold text-amber-700 cursor-pointer hover:underline">jupyter</span>.
        </p>
      </div>
    </div>
  );

}

export default App;
