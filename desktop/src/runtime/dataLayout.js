import path from "node:path";

function requiredAbsolutePath(value, fieldName) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new Error(`${fieldName} 不能为空`);
  }
  return path.resolve(normalized);
}

/**
 * 运行时唯一数据布局。
 *
 * 此函数不读写磁盘、不会生成密钥，也不接受独立的 DB/JSON 路径；所有持久
 * 路径均从 dataRoot 派生，便于开发、安装版、便携版和隔离测试共享同一规则。
 */
export function resolveDataLayout({ dataRoot, localApiRoot = "" }) {
  const root = requiredAbsolutePath(dataRoot, "dataRoot");
  const resolvedLocalApiRoot = String(localApiRoot || "").trim()
    ? path.resolve(localApiRoot)
    : "";
  const localApiDataRoot = path.join(root, "local-api-data");

  return Object.freeze({
    dataRoot: root,
    profilePath: path.join(root, "profile.json"),
    localDataRoot: path.join(root, "本地数据"),
    logDirectory: path.join(root, "logs"),
    runtimeDirectory: path.join(root, "runtime"),
    profileLockPath: path.join(root, "runtime", "profile.lock"),
    backupDirectory: path.join(root, "backups"),
    temporaryDirectory: path.join(root, "tmp"),
    localApiDataRoot,
    // databasePath remains the compatibility name for the profile-wide control
    // and business database. Independent rebuildable shop caches use
    // shopDatabaseRoot and never replace shared collection-box ownership.
    databasePath: path.join(localApiDataRoot, "wangzai-local-api.sqlite"),
    sharedDatabasePath: path.join(localApiDataRoot, "wangzai-local-api.sqlite"),
    shopDatabaseRoot: path.join(localApiDataRoot, "shop-databases"),
    aggregateIndexPath: path.join(localApiDataRoot, "shop-aggregate-index.sqlite"),
    shopDatabaseBackupRoot: path.join(root, "backups", "shop-databases"),
    secretPath: path.join(localApiDataRoot, "local-api-secret.key"),
    protectedComputeVersionStatePath: path.join(
      localApiDataRoot,
      "protected-compute-version-state.enc",
    ),
    legacySecretPath: resolvedLocalApiRoot
      ? path.join(resolvedLocalApiRoot, "data", "local-api-secret.key")
      : "",
  });
}
