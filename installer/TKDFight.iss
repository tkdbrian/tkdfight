#define AppName "TKD Fight"
#define AppVersion "3.0.0"
#define AppPublisher "BL System"
#define AppId "{{9D7FA185-20A1-4E23-A953-8A3D32C87EA1}}"

[Setup]
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\TKD Fight
DefaultGroupName=TKD Fight
OutputDir=..\release
OutputBaseFilename=TKD-Fight-Setup-{#AppVersion}-x64
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
PrivilegesRequired=admin
DisableProgramGroupPage=yes
UninstallDisplayName={#AppName}
UninstallFilesDir={app}\Uninstall
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"

[Dirs]
Name: "{commonappdata}\TKD Fight"; Permissions: users-modify
Name: "{commonappdata}\TKD Fight\data"; Permissions: users-modify
Name: "{commonappdata}\TKD Fight\data-t1"; Permissions: users-modify
Name: "{commonappdata}\TKD Fight\data-t2"; Permissions: users-modify
Name: "{commonappdata}\TKD Fight\data-t3"; Permissions: users-modify
Name: "{commonappdata}\TKD Fight\data-central"; Permissions: users-modify
Name: "{commonappdata}\TKD Fight\logs"; Permissions: users-modify

[Files]
Source: "..\dist-produccion\ABRIR_TKD.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist-produccion\INSTRUCCIONES.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist-produccion\LEEME_SI_NO_FUNCIONA.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist-produccion\sistema\*"; DestDir: "{app}\sistema"; Excludes: "data\*;data-t1\*;data-t2\*;data-t3\*;data-central\*;logs\*"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\dist-produccion\Prerequisites\vc_redist.x64.exe"; DestDir: "{tmp}"; Flags: dontcopy
Source: "..\scripts\Ensure-VCRedist.ps1"; DestDir: "{tmp}"; Flags: dontcopy
Source: "installed.marker"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist-produccion\sistema\data\ring.json"; DestDir: "{commonappdata}\TKD Fight\data"; Flags: onlyifdoesntexist uninsneveruninstall
Source: "..\dist-produccion\sistema\data-t1\ring.json"; DestDir: "{commonappdata}\TKD Fight\data-t1"; Flags: onlyifdoesntexist uninsneveruninstall
Source: "..\dist-produccion\sistema\data-t2\ring.json"; DestDir: "{commonappdata}\TKD Fight\data-t2"; Flags: onlyifdoesntexist uninsneveruninstall
Source: "..\dist-produccion\sistema\data-t3\ring.json"; DestDir: "{commonappdata}\TKD Fight\data-t3"; Flags: onlyifdoesntexist uninsneveruninstall
Source: "..\dist-produccion\sistema\data-central\ring.json"; DestDir: "{commonappdata}\TKD Fight\data-central"; Flags: onlyifdoesntexist uninsneveruninstall

[Icons]
Name: "{autoprograms}\TKD Fight"; Filename: "{app}\ABRIR_TKD.bat"; WorkingDir: "{app}"
Name: "{autodesktop}\TKD Fight"; Filename: "{app}\ABRIR_TKD.bat"; WorkingDir: "{app}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Crear acceso directo en el escritorio"; GroupDescription: "Accesos directos:"; Flags: unchecked

[Run]
Filename: "{sys}\cmd.exe"; Parameters: "/c ""{app}\ABRIR_TKD.bat"""; Description: "Iniciar TKD Fight"; WorkingDir: "{app}"; Flags: postinstall nowait skipifsilent

[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Result := '';
  ExtractTemporaryFile('vc_redist.x64.exe');
  ExtractTemporaryFile('Ensure-VCRedist.ps1');
  if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}\Ensure-VCRedist.ps1') +
    '" -InstallerPath "' + ExpandConstant('{tmp}\vc_redist.x64.exe') + '"',
    '', SW_SHOW, ewWaitUntilTerminated, ResultCode) then
  begin
    Result := 'No se pudo iniciar la preparacion de Microsoft Visual C++ Redistributable x64.';
    Exit;
  end;

  if ResultCode = 3010 then
  begin
    NeedsRestart := True;
    Result := 'Microsoft Visual C++ Redistributable requiere reiniciar Windows. Reinicia y vuelve a ejecutar el instalador.';
    Exit;
  end;
  if ResultCode <> 0 then
    Result := 'No se pudo instalar o validar Microsoft Visual C++ Redistributable x64. Codigo: ' + IntToStr(ResultCode);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    if not Exec(ExpandConstant('{sys}\netsh.exe'),
      'advfirewall firewall add rule name="TKD Fight TCP 3001" dir=in action=allow protocol=TCP localport=3001 profile=private,domain',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then
      MsgBox('No se pudo configurar automaticamente el Firewall. TKD Fight funcionara en esta PC, pero otros equipos podrian no conectarse. Habilita TCP 3001 solo en redes privadas.', mbInformation, MB_OK);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ResultCode: Integer;
begin
  if CurUninstallStep = usUninstall then
    Exec(ExpandConstant('{sys}\netsh.exe'),
      'advfirewall firewall delete rule name="TKD Fight TCP 3001"',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;
