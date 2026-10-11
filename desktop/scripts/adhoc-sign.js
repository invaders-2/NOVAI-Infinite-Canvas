/* 没有 Apple 开发者证书时，给 macOS 产物做 ad-hoc 签名：不签名下载后会被 Gatekeeper 判「已损坏」。
   放在 afterPack（app 已打好、制作 dmg/zip 之前）执行，保证 dmg / zip / latest-mac.yml 里都是签名后的 app。
   签名失败只告警不阻断构建（与 build-mac.py 的策略一致），CI 里另有一步校验签名结果。 */
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');

module.exports = async function adhocSignMacApp(context) {
  if (process.platform !== 'darwin') return;
  const appPath = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app');
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
    console.log('[adhoc-sign] 已对 ' + appPath + ' 做 ad-hoc 签名并通过校验');
  } catch (err) {
    console.warn('[adhoc-sign] ad-hoc 签名失败（不阻断构建）：' + (err && err.message || err));
  }
};
