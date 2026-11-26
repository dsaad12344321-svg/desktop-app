$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repo = 'dsaad12344321-svg/desktop-app'
$branch = 'main'
$project = (Resolve-Path (Join-Path $PSScriptRoot '.')).Path
$tempRoot = Join-Path $env:TEMP ('LongBeachUpdate_' + [guid]::NewGuid().ToString('N'))
$zipPath = Join-Path $tempRoot 'source.zip'
$extractPath = Join-Path $tempRoot 'extracted'
$stagePath = Join-Path $tempRoot 'stage'

function Stop-WithMessage([string]$message) {
    Write-Host ''
    Write-Host "ERROR: $message" -ForegroundColor Red
    throw $message
}

try {
    Write-Host 'Checking Windows PowerShell and project files...'
    if (-not (Test-Path (Join-Path $project 'package.json'))) {
        Stop-WithMessage 'package.json was not found. Run this updater from the project root folder.'
    }

    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $extractPath -Force | Out-Null
    New-Item -ItemType Directory -Path $stagePath -Force | Out-Null

    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $downloadUrl = "https://codeload.github.com/$repo/zip/refs/heads/$branch"
    Write-Host 'Downloading the latest project ZIP from GitHub...'
    Invoke-WebRequest -Uri $downloadUrl -OutFile $zipPath -UseBasicParsing

    if (-not (Test-Path $zipPath) -or (Get-Item $zipPath).Length -lt 1000) {
        Stop-WithMessage 'The downloaded ZIP is missing or unexpectedly small. Your current project was not changed.'
    }

    Write-Host 'Extracting the update into a temporary folder...'
    Expand-Archive -LiteralPath $zipPath -DestinationPath $extractPath -Force
    $sourceRoot = Get-ChildItem -LiteralPath $extractPath -Directory | Select-Object -First 1
    if (-not $sourceRoot -or -not (Test-Path (Join-Path $sourceRoot.FullName 'package.json'))) {
        Stop-WithMessage 'The downloaded archive does not contain a valid project. Your current project was not changed.'
    }

    $oldPackage = Join-Path $project 'package.json'
    $oldLock = Join-Path $project 'package-lock.json'
    $newPackage = Join-Path $sourceRoot.FullName 'package.json'
    $newLock = Join-Path $sourceRoot.FullName 'package-lock.json'
    $depsChanged = $false

    if ((Test-Path $oldPackage) -and (Test-Path $newPackage)) {
        $depsChanged = -not ((Get-FileHash $oldPackage -Algorithm SHA256).Hash -eq (Get-FileHash $newPackage -Algorithm SHA256).Hash)
    }
    if ((Test-Path $oldLock) -and (Test-Path $newLock)) {
        if ((Get-FileHash $oldLock -Algorithm SHA256).Hash -ne (Get-FileHash $newLock -Algorithm SHA256).Hash) { $depsChanged = $true }
    } elseif ((Test-Path $oldLock) -ne (Test-Path $newLock)) {
        $depsChanged = $true
    }

    Write-Host 'Preparing files. Existing node_modules and local data will be kept...'
    $excludeDirs = @('node_modules', '.git', '.next', 'release', 'dist', 'data', 'userdata', 'user-data')
    $excludeFiles = @('.env', '.env.local', '.env.development.local', '.env.production.local')
    $args = @($sourceRoot.FullName, $stagePath, '/E', '/R:2', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
    foreach ($dir in $excludeDirs) { $args += @('/XD', $dir) }
    foreach ($file in $excludeFiles) { $args += @('/XF', $file) }
    & robocopy @args | Out-Null
    if ($LASTEXITCODE -ge 8) {
        Stop-WithMessage "Could not prepare the update files (Robocopy exit code $LASTEXITCODE). Your project files were not changed."
    }

    Write-Host 'Applying the update to the current project...'
    $copyArgs = @($stagePath, $project, '/E', '/R:2', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
    foreach ($dir in $excludeDirs) { $copyArgs += @('/XD', (Join-Path $project $dir)) }
    foreach ($file in $excludeFiles) { $copyArgs += @('/XF', $file) }
    & robocopy @copyArgs | Out-Null
    if ($LASTEXITCODE -ge 8) {
        Stop-WithMessage "Some files could not be copied (Robocopy exit code $LASTEXITCODE). Close the app and run the updater again."
    }

    if ($depsChanged) {
        Write-Host ''
        Write-Host 'Dependency manifests changed. Running npm install to update only required packages...'
        Push-Location $project
        try {
            & npm install
            if ($LASTEXITCODE -ne 0) { Stop-WithMessage 'npm install failed. Check your connection, then run Update-Project.bat again.' }
        } finally { Pop-Location }
    } else {
        Write-Host 'Dependencies are unchanged. Existing node_modules was preserved.'
    }

    Write-Host ''
    Write-Host 'UPDATE COMPLETED SUCCESSFULLY.' -ForegroundColor Green
    Write-Host 'Your existing node_modules and excluded local data folders were preserved.'
    Write-Host 'You can now start the app using Start-Developer-Mode.bat.'
} catch {
    if ($_.Exception.Message -notmatch '^ERROR:') {
        Write-Host ''
        Write-Host "Update failed: $($_.Exception.Message)" -ForegroundColor Red
    }
    exit 1
} finally {
    if (Test-Path $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
}