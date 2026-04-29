param(
    [string]$ProjectRoot = "C:\Users\chens\Desktop\camera_project",
    [string]$DataRoot = "D:\camera_agent_data",
    [string]$RepoUrl = "https://github.com/OpenMOSS/MOSS-TTS-Nano.git"
)

$ErrorActionPreference = "Stop"

function Invoke-Checked {
    param(
        [string]$FilePath,
        [string[]]$Arguments
    )
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $FilePath $($Arguments -join ' ')"
    }
}

$mossRoot = Join-Path $DataRoot "local_models\moss"
$sourceDir = Join-Path $mossRoot "MOSS-TTS-Nano"
$venvDir = Join-Path $DataRoot "venvs\moss-tts"
$venvPython = Join-Path $venvDir "Scripts\python.exe"
$requirements = Join-Path $ProjectRoot "requirements_moss_tts_onnx.txt"

New-Item -ItemType Directory -Force -Path $mossRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $DataRoot "venvs") | Out-Null

if (-not (Test-Path $sourceDir)) {
    Invoke-Checked "git" @("-c", "http.proxy=", "-c", "https.proxy=", "clone", $RepoUrl, $sourceDir)
}

if (-not (Test-Path $venvPython)) {
    py -3.11 -m venv $venvDir
}

Invoke-Checked $venvPython @("-m", "pip", "install", "--upgrade", "pip")
Invoke-Checked $venvPython @("-m", "pip", "install", "torch==2.7.0", "torchaudio==2.7.0", "--index-url", "https://download.pytorch.org/whl/cpu")
Invoke-Checked $venvPython @("-m", "pip", "install", "-r", $requirements)
Invoke-Checked $venvPython @("-m", "pip", "install", "-e", $sourceDir, "--no-deps")

Write-Host "MOSS-TTS-Nano ONNX CPU environment is ready."
Write-Host "Source: $sourceDir"
Write-Host "Python: $venvPython"
