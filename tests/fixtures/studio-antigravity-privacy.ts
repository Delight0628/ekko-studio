import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export interface WindowsImageAcl {
  currentSid: string
  ownerSid: string
  hasDacl: boolean
  allowReadSids: string[]
}

/** NTFS access is controlled by DACLs; Node's synthesized mode bits cannot assert image privacy. */
export async function windowsImageAcl(path: string): Promise<WindowsImageAcl> {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath $env:STUDIO_AGY_TEST_IMAGE_PATH
$descriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
$readers = @($rules | Where-Object {
  $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
  (([int64]$_.FileSystemRights -band 1) -ne 0)
} | ForEach-Object { $_.IdentityReference.Value })
[ordered]@{
  currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  hasDacl = (($descriptor.ControlFlags -band [System.Security.AccessControl.ControlFlags]::DiscretionaryAclPresent) -ne 0)
  allowReadSids = @($readers)
} | ConvertTo-Json -Compress
`
  const { stdout } = await promisify(execFile)(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { env: { ...process.env, STUDIO_AGY_TEST_IMAGE_PATH: path }, windowsHide: true, maxBuffer: 65536 },
  )
  return JSON.parse(stdout.replace(/^\uFEFF/, '').trim()) as WindowsImageAcl
}

/** Administrative principals can inspect local processes on Windows independently of file permissions. */
export function nonOwnerImageReaders(acl: WindowsImageAcl): string[] {
  if (
    !acl.hasDacl ||
    !/^S-1-(?:\d+-)+\d+$/.test(acl.currentSid) ||
    !/^S-1-(?:\d+-)+\d+$/.test(acl.ownerSid) ||
    !Array.isArray(acl.allowReadSids)
  ) {
    throw new Error('Windows image privacy requires a valid discretionary ACL and current user identity')
  }
  const permitted = new Set([acl.currentSid, 'S-1-5-18', 'S-1-5-32-544'])
  return [...new Set([acl.ownerSid, ...acl.allowReadSids].filter((sid) => !permitted.has(sid)))]
}
