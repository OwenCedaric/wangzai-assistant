import { useDataMaintenance } from '../model/useDataMaintenance.js';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Dialog from '../../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import React from 'react';
import { STABLE_SELECT_MENU_PROPS } from './stableSelectMenuProps.js';

function summaryItems(summary = {}) {
  return Object.entries(summary).map(([key, value]) => ({
    key,
    tables: Number(value?.tables) || 0,
    rows: Number(value?.rows) || 0,
    emptyShopId: Number(value?.emptyShopId) || 0,
  }));
}

const SUMMARY_LABELS = {
  owner: { shop: '店铺账户', profile: '账户通用', system: '系统', unclassified: '未登记' },
  lifecycle: { preserve: '必须保留', rehydrate: '可重建', runtime: '运行态', unclassified: '未分类' },
  backup: { required: '必须备份', optional: '可选备份', excluded: '不备份', null: '未登记' },
};

function summaryLabel(kind, key) {
  return SUMMARY_LABELS[kind]?.[key] || key;
}

function SummaryBlock({ title, summary, kind }) {
  const items = summaryItems(summary);
  return (
    <Box className="data-maintenance-summary-block">
      <Typography variant="subtitle2">{title}</Typography>
      <Stack spacing={0.75} mt={1}>
        {items.map((item) => (
          <Stack key={item.key} direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
            <Typography variant="body2">{summaryLabel(kind, item.key)}</Typography>
            <Typography variant="caption" color="text.secondary">
              {item.tables} 表 / {item.rows} 行{item.emptyShopId ? ` / 空店铺 ${item.emptyShopId}` : ''}
            </Typography>
          </Stack>
        ))}
      </Stack>
    </Box>
  );
}

function actionLabel(action) {
  const labels = {
    'assign-after-confirmation': '单店手工数据回填',
    'purge-runtime-after-confirmation': '系统运行数据清理',
    'rehydrate-from-source-after-confirmation': '待来源续传',
    'isolate-for-manual-resolution': '待人工隔离',
    'schema-repair-required': '需修复表结构',
  };
  return labels[action] || action || '无需处理';
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '未知';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export function DataMaintenancePanel() {
  const {
    audit,
    consistencyAudit,
    compactionPreview,
    scopePreview,
    manualResolutionPreview,
    retentionPreview,
    profileMaintenanceContracts,
    spaceReleasePreview,
    domainRebuildPreparation,
    loading,
    checkingConsistency,
    repairing,
    resolving,
    retaining,
    compacting,
    releasingSpace,
    preparingDomainRebuild,
    rebuildingDomain,
    startingCacheMaintenance,
    error,
    lastResult,
    lastManualResolutionResult,
    lastRetentionResult,
    retentionJob,
    lastCompactionResult,
    lastSpaceReleaseResult,
    lastDomainRebuildResult,
    refresh,
    runConsistencyAudit,
    repairSafeScopeRows,
    resolveManualScopeRows,
    retainTechnicalRows,
    compactDatabase,
    releaseProfileSpace,
    prepareDomainRebuild,
    rebuildPreparedDomain,
    cancelDomainRebuild,
    startProfileCacheMaintenance,
  } = useDataMaintenance();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [manualConfirmOpen, setManualConfirmOpen] = React.useState(false);
  const [retentionConfirmOpen, setRetentionConfirmOpen] = React.useState(false);
  const [compactionConfirmOpen, setCompactionConfirmOpen] = React.useState(false);
  const [spaceReleaseConfirmOpen, setSpaceReleaseConfirmOpen] = React.useState(false);
  const [backupAcknowledged, setBackupAcknowledged] = React.useState(false);
  const [compactionBackupAcknowledged, setCompactionBackupAcknowledged] = React.useState(false);
  const [spaceReleaseAcknowledged, setSpaceReleaseAcknowledged] = React.useState(false);
  const [domainRebuildAcknowledged, setDomainRebuildAcknowledged] = React.useState(false);
  const [selectedRebuildDomain, setSelectedRebuildDomain] = React.useState('');
  const [manualAssignments, setManualAssignments] = React.useState({});
  const allScopeTables = Array.isArray(scopePreview?.tables) ? scopePreview.tables : [];
  const pendingRows = allScopeTables.filter((item) => Number(item.emptyRows) > 0);
  const repairable = pendingRows.filter((item) => (
    item.action === 'assign-after-confirmation' || item.action === 'purge-runtime-after-confirmation'
  ));
  const deferred = pendingRows.filter((item) => !repairable.includes(item));
  const classification = audit?.classificationSummary || {};
  const retentionCandidates = Number(retentionPreview?.maximumCandidateRows) || 0;
  const retentionTables = (Array.isArray(retentionPreview?.tables) ? retentionPreview.tables : [])
    .filter((item) => Number(item.candidateRows || item.maximumCandidateRows) > 0);
  const manualCandidates = Array.isArray(manualResolutionPreview?.candidates) ? manualResolutionPreview.candidates : [];
  const manualShops = Array.isArray(manualResolutionPreview?.shops) ? manualResolutionPreview.shops : [];
  const manualAssignmentsToConfirm = manualCandidates
    .map((candidate) => ({ candidateId: candidate.id, targetShopId: manualAssignments[candidate.id] || '' }))
    .filter((assignment) => assignment.targetShopId);
  const manualTotalCandidates = Number(manualResolutionPreview?.totalCandidates) || 0;
  const compactionReclaimableBytes = Number(compactionPreview?.sqlite?.reclaimableBytes) || 0;
  const consistencyDuplicateKeyGroups = Number(consistencyAudit?.keys?.duplicateKeyGroups) || 0;
  const consistencyEmptyShopRows = Number(consistencyAudit?.scopes?.emptyShopRows) || 0;
  const consistencyReady = consistencyAudit?.readyForMigration === true;
  const spaceReleaseRows = Number(spaceReleasePreview?.targetRows) || 0;
  const spaceReleaseResources = Array.isArray(spaceReleasePreview?.targetResources)
    ? spaceReleasePreview.targetResources
    : [];
  const rebuildDomains = React.useMemo(() => {
    const domains = profileMaintenanceContracts?.commands?.['rebuild-domain']?.targetDomains;
    return Array.isArray(domains) ? domains : [];
  }, [profileMaintenanceContracts]);

  React.useEffect(() => {
    if (!rebuildDomains.length) {
      setSelectedRebuildDomain('');
      return;
    }
    if (!rebuildDomains.includes(selectedRebuildDomain)) setSelectedRebuildDomain(rebuildDomains[0]);
  }, [rebuildDomains, selectedRebuildDomain]);

  const confirmRepair = async () => {
    const result = await repairSafeScopeRows();
    if (result?.ok) setConfirmOpen(false);
  };

  const confirmRetention = async () => {
    const result = await retainTechnicalRows();
    if (result?.ok) {
      setRetentionConfirmOpen(false);
      setBackupAcknowledged(false);
    }
  };

  const openManualResolution = () => {
    setManualAssignments({});
    setManualConfirmOpen(true);
  };

  const confirmManualResolution = async () => {
    const result = await resolveManualScopeRows(manualAssignmentsToConfirm);
    if (result?.ok) {
      setManualConfirmOpen(false);
      setManualAssignments({});
    }
  };

  const confirmCompaction = async () => {
    const result = await compactDatabase();
    if (result?.ok) {
      setCompactionConfirmOpen(false);
      setCompactionBackupAcknowledged(false);
    }
  };

  const confirmSpaceRelease = async () => {
    const result = await releaseProfileSpace();
    if (result?.ok) {
      setSpaceReleaseConfirmOpen(false);
      setSpaceReleaseAcknowledged(false);
    }
  };

  const openDomainRebuild = async () => {
    setDomainRebuildAcknowledged(false);
    await prepareDomainRebuild(selectedRebuildDomain);
  };

  const closeDomainRebuild = () => {
    if (rebuildingDomain) return;
    setDomainRebuildAcknowledged(false);
    cancelDomainRebuild();
  };

  const confirmDomainRebuild = async () => {
    const result = await rebuildPreparedDomain();
    if (result?.ok) setDomainRebuildAcknowledged(false);
  };

  return (
    <Box className="settings-module-panel data-maintenance-panel">
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1.5} mb={2}>
        <Box>
          <Typography variant="h6">数据归属维护</Typography>
          <Typography variant="body2" color="text.secondary">
            只读取本机 SQLite：区分店铺、账户、系统和可重建数据，不调用 Ozon。
          </Typography>
        </Box>
        <Button size="small" variant="outlined" startIcon={<RefreshRounded />} onClick={refresh} disabled={loading || checkingConsistency || repairing || resolving || compacting || releasingSpace}>
          {loading ? '检查中' : '重新检查'}
        </Button>
      </Stack>

      {error ? <Alert severity="error" sx={{ mb: 1.5 }}>{error}</Alert> : null}
      {lastResult?.ok ? (
        <Alert severity="success" sx={{ mb: 1.5 }}>
          已完成安全修复：{lastResult.applied?.reduce((total, item) => total + (Number(item.changed) || 0), 0) || 0} 行；
          仍有 {lastResult.deferred?.length || 0} 项需来源续传或人工处理。
        </Alert>
      ) : null}
      {lastManualResolutionResult?.ok ? (
        <Alert severity="success" sx={{ mb: 1.5 }}>
          已完成多店数据归属：{lastManualResolutionResult.applied?.length || 0} 条。剩余候选请继续逐条明确选择店铺。
        </Alert>
      ) : null}
      {lastRetentionResult?.ok ? (
        <Alert severity="success" sx={{ mb: 1.5 }}>
          已清理技术运行数据：{lastRetentionResult.deleted?.reduce((total, item) => total + (Number(item.rows) || 0), 0) || 0} 行。
          SQLite 文件页会在后续受控压缩后再回收。
        </Alert>
      ) : null}
      {retentionJob?.active ? (
        <Alert severity="info" sx={{ mb: 1.5 }}>
          技术运行数据正在后台清理：已处理 {retentionJob.processedRows || 0} / {retentionJob.totalCandidateRows || 0} 行，
          剩余 {retentionJob.remainingCandidateRows || 0} 行。页面可继续使用。
        </Alert>
      ) : null}
      {lastCompactionResult?.ok && lastCompactionResult.mode !== 'confirmed-noop' ? (
        <Alert severity="success" sx={{ mb: 1.5 }}>
          已完成 SQLite 物理压缩：回收 {formatBytes(lastCompactionResult.reclaimedDatabaseBytes ?? lastCompactionResult.reclaimedLogicalBytes)}。
        </Alert>
      ) : null}
      {lastSpaceReleaseResult?.ok ? (
        <Alert severity="success" sx={{ mb: 1.5 }}>
          已释放 {lastSpaceReleaseResult.releasedRows || 0} 行派生缓存；受保护数据指纹回读一致。
        </Alert>
      ) : null}
      {lastDomainRebuildResult?.ok ? (
        <Alert severity="success" sx={{ mb: 1.5 }}>
          已从可信来源重建 {lastDomainRebuildResult.domain}；staging、原子激活及受保护指纹回读均已通过。
        </Alert>
      ) : null}

      <Box className="settings-module-card-grid">
        <Box className="settings-module-card">
          <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
            <Typography variant="subtitle1">归属审计</Typography>
            <Chip size="small" color={audit?.ok ? 'success' : 'default'} label={audit?.ok ? '只读完成' : '等待检查'} variant="outlined" />
          </Stack>
          <Typography variant="body2" color="text.secondary">
            已登记 {classification.registeredTables ?? 0} 张表，未登记 {classification.unclassifiedTables ?? 0} 张表。
          </Typography>
        </Box>
        <Box className="settings-module-card">
          <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
            <Typography variant="subtitle1">完整性核验</Typography>
            <Chip
              size="small"
              color={consistencyAudit ? consistencyReady ? 'success' : 'warning' : 'default'}
              label={checkingConsistency ? '核验中' : consistencyAudit ? consistencyReady ? '结构通过' : '需处理' : '未运行'}
              variant="outlined"
            />
          </Stack>
          <Typography variant="body2" color="text.secondary">
            {consistencyAudit
              ? `重复业务键 ${consistencyDuplicateKeyGroups} 组 / 空店铺 ${consistencyEmptyShopRows} 行。`
              : '按需只读检查 SQLite 完整性、外键、注册表和业务键；不会请求 Ozon。'}
          </Typography>
        </Box>
        <Box className="settings-module-card">
          <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
            <Typography variant="subtitle1">SQLite 可压缩空间</Typography>
            <Chip size="small" color={compactionReclaimableBytes ? 'warning' : 'success'} label={formatBytes(compactionReclaimableBytes)} variant="outlined" />
          </Stack>
          <Typography variant="body2" color="text.secondary">
            已删除的技术记录先成为可回收页；物理缩小文件必须单独确认。
          </Typography>
        </Box>
        <Box className="settings-module-card">
          <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
            <Typography variant="subtitle1">多店人工归属</Typography>
            <Chip size="small" color={manualTotalCandidates ? 'warning' : 'success'} label={`${manualTotalCandidates} 条`} variant="outlined" />
          </Stack>
          <Typography variant="body2" color="text.secondary">
            多店手工数据必须逐条由你选择归属店铺，系统不会按当前店铺猜测。
          </Typography>
        </Box>
        <Box className="settings-module-card">
          <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
            <Typography variant="subtitle1">技术运行保留</Typography>
            <Chip size="small" color={retentionCandidates ? 'warning' : 'success'} label={`${retentionCandidates} 行`} variant="outlined" />
          </Stack>
          <Typography variant="body2" color="text.secondary">
            仅清理过期 trace、任务、锁和快照；业务事实、配置和凭证不在此范围。
          </Typography>
        </Box>
        <Box className="settings-module-card">
          <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
            <Typography variant="subtitle1">空店铺作用域</Typography>
            <Chip size="small" color={scopePreview?.totalEmptyRows ? 'warning' : 'success'} label={`${scopePreview?.totalEmptyRows ?? 0} 行`} variant="outlined" />
          </Stack>
          <Typography variant="body2" color="text.secondary">
            可安全处理 {repairable.reduce((total, item) => total + (Number(item.emptyRows) || 0), 0)} 行；其余保留等待来源或人工决定。
          </Typography>
        </Box>
      </Box>

      <Box className="data-maintenance-summary-grid">
        <SummaryBlock title="按归属" summary={classification.byOwnerScope} kind="owner" />
        <SummaryBlock title="按生命周期" summary={classification.byLifecycle} kind="lifecycle" />
        <SummaryBlock title="按备份策略" summary={classification.byBackup} kind="backup" />
      </Box>

      <Divider sx={{ my: 2 }} />
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1.5} mb={1}>
        <Box>
          <Typography variant="subtitle1">普通清缓存</Typography>
          <Typography variant="body2" color="text.secondary">
            重启到独立维护模式，只读预览后由原生窗口再次确认；仅清 Renderer、local-api、响应缓存和临时文件。
          </Typography>
        </Box>
        <Button
          variant="outlined"
          onClick={startProfileCacheMaintenance}
          disabled={startingCacheMaintenance || loading || checkingConsistency || repairing || resolving || retaining || compacting || releasingSpace || preparingDomainRebuild || rebuildingDomain}
        >
          {startingCacheMaintenance ? '正在切换维护模式' : '普通清缓存'}
        </Button>
      </Stack>
      <Alert severity="info">
        商品、订单、佣金、价格、库存、材积、财务、售后、设定和凭证均受保护；此命令不执行释放空间、领域重建或永久删除。
      </Alert>

      <Divider sx={{ my: 2 }} />
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1.5} mb={1}>
        <Box>
          <Typography variant="subtitle1">完整性与迁移预检</Typography>
          <Typography variant="body2" color="text.secondary">
            显式检查本机 SQLite 完整性、外键、已登记表和必须保留数据的业务键；不返回行内容，不写入数据。
          </Typography>
        </Box>
        <Button
          variant="outlined"
          onClick={runConsistencyAudit}
          disabled={checkingConsistency || loading || repairing || resolving || retaining || compacting}
        >
          {checkingConsistency ? '核验中' : '运行完整性核验'}
        </Button>
      </Stack>
      {consistencyAudit ? (
        <Alert severity={consistencyReady ? 'success' : 'warning'}>
          {consistencyReady ? '结构、业务键和店铺作用域预检通过。' : '发现需要先处理的结构、业务键或空店铺作用域项。'}
          {' '}SQLite 完整性：{consistencyAudit.integrity?.ok ? '通过' : '失败'}；外键：{consistencyAudit.foreignKeys?.ok ? '通过' : `发现 ${consistencyAudit.foreignKeys?.violations || 0} 项`}；
          未登记表：{consistencyAudit.registry?.unclassifiedTables?.length || 0}；结构漂移：{consistencyAudit.registry?.schemaDriftTables?.length || 0}；
          重复业务键：{consistencyDuplicateKeyGroups} 组；空店铺：{consistencyEmptyShopRows} 行。
          {consistencyEmptyShopRows ? ' 空店铺数据仍必须走上方预览和人工确认路径。' : ''}
        </Alert>
      ) : (
        <Typography variant="body2" color="text.secondary">尚未运行完整性预检；该检查不会自动修复或迁移任何记录。</Typography>
      )}

      <Divider sx={{ my: 2 }} />
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1.5} mb={1}>
        <Box>
          <Typography variant="subtitle1">修复预览</Typography>
          <Typography variant="body2" color="text.secondary">
            必须先检查，再对同一预览明确确认；数据变化会自动拒绝执行。
          </Typography>
        </Box>
        <Button variant="contained" onClick={() => setConfirmOpen(true)} disabled={!repairable.length || loading || checkingConsistency || repairing || compacting}>
          确认修复安全项
        </Button>
      </Stack>
      <Stack spacing={0.75}>
        {pendingRows.length ? pendingRows.map((item) => (
          <Stack key={item.table} direction="row" alignItems="center" justifyContent="space-between" spacing={1} className="data-maintenance-row">
            <Box>
              <Typography variant="body2">{item.domain || item.table}</Typography>
              <Typography variant="caption" color="text.secondary">{item.table}</Typography>
            </Box>
            <Stack direction="row" spacing={1} alignItems="center">
              <Chip size="small" label={`${item.emptyRows} 行`} variant="outlined" />
              <Chip size="small" color={repairable.includes(item) ? 'warning' : 'default'} label={actionLabel(item.action)} variant="outlined" />
            </Stack>
          </Stack>
        )) : (
          <Typography variant="body2" color="success.main">没有发现空店铺作用域。</Typography>
        )}
      </Stack>

      <Divider sx={{ my: 2 }} />
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1.5} mb={1}>
        <Box>
          <Typography variant="subtitle1">派生缓存空间释放</Typography>
          <Typography variant="body2" color="text.secondary">
            只处理统一资源注册表批准的响应缓存和缓存键；商品、订单、采购、设定、凭证及来源事实全部受指纹保护。
          </Typography>
        </Box>
        <Button
          variant="outlined"
          color="warning"
          onClick={() => setSpaceReleaseConfirmOpen(true)}
          disabled={!spaceReleaseRows || loading || checkingConsistency || repairing || resolving || retaining || compacting || releasingSpace}
        >
          释放派生缓存
        </Button>
      </Stack>
      {spaceReleaseResources.length ? (
        <Stack spacing={0.75}>
          {spaceReleaseResources.map((resource) => (
            <Stack key={resource.resourceId} direction="row" alignItems="center" justifyContent="space-between" spacing={1} className="data-maintenance-row">
              <Box>
                <Typography variant="body2">{resource.domain}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {resource.resourceId} / {resource.table}
                </Typography>
              </Box>
              <Chip size="small" color="warning" label={`${resource.rows || 0} 行`} variant="outlined" />
            </Stack>
          ))}
        </Stack>
      ) : (
        <Typography variant="body2" color="success.main">当前没有可释放的派生缓存行。</Typography>
      )}
      <Alert severity="info" sx={{ mt: 1.5 }}>
        当前有 {rebuildDomains.length} 个领域已接入可信来源；必须由 local-api 内部同步 adapter 读取持久成功证明并签发一次性 ticket，维护页不接受手工粘贴数据或自签 hash。
      </Alert>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }} mt={1.5}>
        <Select
          size="small"
          value={selectedRebuildDomain}
          onChange={(event) => setSelectedRebuildDomain(event.target.value)}
          inputProps={{ 'aria-label': '选择可信来源重建领域' }}
          disabled={!rebuildDomains.length || preparingDomainRebuild || rebuildingDomain}
          sx={{ minWidth: 240 }}
          MenuProps={STABLE_SELECT_MENU_PROPS}
        >
          {rebuildDomains.map((domain) => <MenuItem key={domain} value={domain}>{domain}</MenuItem>)}
        </Select>
        <Button
          variant="outlined"
          onClick={openDomainRebuild}
          disabled={!selectedRebuildDomain || loading || preparingDomainRebuild || rebuildingDomain}
        >
          {preparingDomainRebuild ? '读取可信来源中' : '检查并重建领域'}
        </Button>
      </Stack>

      <Divider sx={{ my: 2 }} />
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1.5} mb={1}>
        <Box>
          <Typography variant="subtitle1">多店手工数据归属</Typography>
          <Typography variant="body2" color="text.secondary">
            只显示未归属手工记录的业务主键；每一条都必须明确选店，再由本机 SQLite 事务回读。
          </Typography>
        </Box>
        <Button
          variant="outlined"
          color="warning"
          onClick={openManualResolution}
          disabled={!manualTotalCandidates || !manualCandidates.length || loading || checkingConsistency || repairing || resolving || compacting}
        >
          处理多店手工数据
        </Button>
      </Stack>
      {manualTotalCandidates ? (
        <Alert severity="info">
          当前有 {manualTotalCandidates} 条待人工归属数据；不会自动分配到当前店铺。
          {manualResolutionPreview?.truncated ? ` 当前仅显示前 ${manualCandidates.length} 条，提交后会继续显示剩余数据。` : ''}
        </Alert>
      ) : (
        <Typography variant="body2" color="success.main">当前没有待人工归属的多店手工数据。</Typography>
      )}

      <Divider sx={{ my: 2 }} />
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1.5} mb={1}>
        <Box>
          <Typography variant="subtitle1">技术运行数据保留</Typography>
          <Typography variant="body2" color="text.secondary">
            清理前必须确认已创建可恢复保护副本；不会自动压缩 SQLite 文件。
          </Typography>
        </Box>
        <Button
          variant="outlined"
          color="warning"
          onClick={() => setRetentionConfirmOpen(true)}
          disabled={!retentionCandidates || loading || checkingConsistency || repairing || retaining || compacting}
        >
          清理技术运行数据
        </Button>
      </Stack>

      <Stack spacing={0.75}>
        {retentionTables.length ? retentionTables.map((item) => (
          <Stack key={item.table} direction="row" alignItems="center" justifyContent="space-between" spacing={1} className="data-maintenance-row">
            <Box>
              <Typography variant="body2">{item.table}</Typography>
              <Typography variant="caption" color="text.secondary">
                超期 {item.eligibleByAge || 0} 行 / 保留上限候选 {item.eligibleByRowLimit || 0} 行
              </Typography>
            </Box>
            <Chip size="small" color="warning" label={`清理 ${item.candidateRows || item.maximumCandidateRows} 行`} variant="outlined" />
          </Stack>
        )) : (
          <Typography variant="body2" color="success.main">当前技术运行数据无需清理。</Typography>
        )}
      </Stack>

      <Divider sx={{ my: 2 }} />
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1.5} mb={1}>
        <Box>
          <Typography variant="subtitle1">SQLite 物理压缩</Typography>
          <Typography variant="body2" color="text.secondary">
            只重建 SQLite 空闲页，不删除任何业务记录；压缩期间本机数据请求会短暂等待。
          </Typography>
        </Box>
        <Button
          variant="outlined"
          color="warning"
          onClick={() => setCompactionConfirmOpen(true)}
          disabled={!compactionPreview?.recommended || loading || checkingConsistency || repairing || resolving || retaining || compacting}
        >
          压缩本机数据库
        </Button>
      </Stack>
      <Typography variant="body2" color={compactionReclaimableBytes ? 'text.secondary' : 'success.main'}>
        {compactionReclaimableBytes
          ? `当前预计可回收约 ${formatBytes(compactionReclaimableBytes)} 的 SQLite 空闲页。`
          : '当前没有可回收的 SQLite 空闲页。'}
      </Typography>

      <Dialog
        open={spaceReleaseConfirmOpen}
        onClose={() => !releasingSpace && setSpaceReleaseConfirmOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>确认释放派生缓存空间</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" color="text.secondary" mb={1.5}>
            将在独占锁内只删除本次只读预览列出的统一注册表缓存；执行后必须通过 schema、受保护表和 SQLite 完整性回读才会提交。
          </Typography>
          <Stack spacing={1}>
            {spaceReleaseResources.map((resource) => (
              <Stack key={resource.resourceId} direction="row" justifyContent="space-between" spacing={1}>
                <Typography variant="body2">{resource.domain}</Typography>
                <Typography variant="body2">{resource.rows || 0} 行</Typography>
              </Stack>
            ))}
          </Stack>
          <Alert severity="warning" sx={{ mt: 1.5 }}>
            此入口不执行永久删除，也不删除商品、订单、采购、财务、客服、配置或凭证。
          </Alert>
          <FormControlLabel
            sx={{ mt: 1 }}
            control={<Checkbox checked={spaceReleaseAcknowledged} onChange={(event) => setSpaceReleaseAcknowledged(event.target.checked)} />}
            label="我已核对本次预览，并确认只释放以上派生缓存"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSpaceReleaseConfirmOpen(false)} disabled={releasingSpace}>取消</Button>
          <Button variant="contained" color="warning" onClick={confirmSpaceRelease} disabled={releasingSpace || !spaceReleaseAcknowledged}>
            {releasingSpace ? '释放并回读中' : '确认释放派生缓存'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={Boolean(domainRebuildPreparation)}
        onClose={closeDomainRebuild}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>确认从可信来源重建领域</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" color="text.secondary" mb={1.5}>
            local-api 已在内部读取可信候选并绑定本次预览。确认后会先写 staging、核对行数与 hash，再在单个 SQLite 事务中替换目标派生领域；任一步失败都会保留原数据。
          </Typography>
          <Stack spacing={0.75}>
            <Typography variant="body2">领域：{domainRebuildPreparation?.domain || '-'}</Typography>
            <Typography variant="body2">来源：{domainRebuildPreparation?.trustedSource?.source || '-'}</Typography>
            <Typography variant="body2">来源证明：{domainRebuildPreparation?.trustedSource?.proofId || '-'}</Typography>
            <Typography variant="body2">候选行数：{domainRebuildPreparation?.trustedSource?.rowCount ?? 0}</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ wordBreak: 'break-all' }}>
              SHA-256：{domainRebuildPreparation?.trustedSource?.rowsSha256 || '-'}
            </Typography>
          </Stack>
          <Alert severity="warning" sx={{ mt: 1.5 }}>
            此命令只重建当前明确选择的派生领域，不是清缓存、释放空间或永久删除。
          </Alert>
          <FormControlLabel
            sx={{ mt: 1 }}
            control={<Checkbox checked={domainRebuildAcknowledged} onChange={(event) => setDomainRebuildAcknowledged(event.target.checked)} />}
            label="我已核对领域、来源证明和候选行数，并确认执行一次原子重建"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDomainRebuild} disabled={rebuildingDomain}>取消</Button>
          <Button
            variant="contained"
            color="warning"
            onClick={confirmDomainRebuild}
            disabled={rebuildingDomain || !domainRebuildAcknowledged}
          >
            {rebuildingDomain ? '重建并回读中' : '确认重建领域'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={confirmOpen} onClose={() => !repairing && setConfirmOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>确认修复安全数据项</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" color="text.secondary" mb={1.5}>
            将只修复下列单店手工数据或删除无归属系统运行数据。多店数据和可重建数据不会改动。
          </Typography>
          <Stack spacing={1}>
            {repairable.map((item) => (
              <Stack key={item.table} direction="row" justifyContent="space-between" spacing={1}>
                <Typography variant="body2">{item.table}</Typography>
                <Typography variant="body2">{actionLabel(item.action)} / {item.emptyRows} 行</Typography>
              </Stack>
            ))}
          </Stack>
          {deferred.length ? (
            <Alert severity="info" sx={{ mt: 1.5 }}>
              {deferred.length} 项不会处理，仍需来源续传或人工隔离。
            </Alert>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)} disabled={repairing}>取消</Button>
          <Button variant="contained" onClick={confirmRepair} disabled={repairing}>
            {repairing ? '修复中' : '确认并修复'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={retentionConfirmOpen}
        onClose={() => !retaining && setRetentionConfirmOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>确认清理技术运行数据</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" color="text.secondary" mb={1.5}>
            将只删除预览中到期或超出上限的 trace、任务、已释放锁和快照。此操作不处理业务事实、配置或凭证。
          </Typography>
          <Stack spacing={1}>
            {retentionTables.map((item) => (
              <Stack key={item.table} direction="row" justifyContent="space-between" spacing={1}>
                <Typography variant="body2">{item.table}</Typography>
                <Typography variant="body2">{item.candidateRows || item.maximumCandidateRows} 行</Typography>
              </Stack>
            ))}
          </Stack>
          <Alert severity="warning" sx={{ mt: 1.5 }}>
            删除后只会增加 SQLite 可回收页；不会自动压缩文件，可在下方单独确认物理压缩。
          </Alert>
          <FormControlLabel
            sx={{ mt: 1 }}
            control={<Checkbox checked={backupAcknowledged} onChange={(event) => setBackupAcknowledged(event.target.checked)} />}
            label="我已创建可恢复保护副本，并确认清理以上技术运行数据"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRetentionConfirmOpen(false)} disabled={retaining}>取消</Button>
          <Button variant="contained" color="warning" onClick={confirmRetention} disabled={retaining || !backupAcknowledged}>
            {retaining ? '清理中' : '确认清理'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={compactionConfirmOpen}
        onClose={() => !compacting && setCompactionConfirmOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>确认压缩本机 SQLite 数据库</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" color="text.secondary" mb={1.5}>
            将先 checkpoint，再执行 SQLite VACUUM 重建空闲页。不会删除商品、订单、配置、凭证或手工记录；运行中本机数据请求会暂时等待。
          </Typography>
          <Alert severity="warning">
            请先创建可恢复保护副本。压缩只能缩小本地文件，不会改变服务器备份内容。
          </Alert>
          <FormControlLabel
            sx={{ mt: 1 }}
            control={<Checkbox checked={compactionBackupAcknowledged} onChange={(event) => setCompactionBackupAcknowledged(event.target.checked)} />}
            label="我已创建可恢复保护副本，并确认压缩本机 SQLite 文件"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCompactionConfirmOpen(false)} disabled={compacting}>取消</Button>
          <Button variant="contained" color="warning" onClick={confirmCompaction} disabled={compacting || !compactionBackupAcknowledged}>
            {compacting ? '压缩中' : '确认压缩'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={manualConfirmOpen}
        onClose={() => !resolving && setManualConfirmOpen(false)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>逐条确认多店手工数据归属</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" color="text.secondary" mb={1.5}>
            系统不会根据当前店铺、名称或关键词猜测归属。请只为你确认无误的记录选择店铺；未选择的记录会保留不动。
          </Typography>
          <Stack spacing={1}>
            {manualCandidates.map((candidate) => {
              const identity = (candidate.identity || [])
                .map((item) => `${item.column}: ${item.value ?? '空'}`)
                .join(' / ');
              return (
                <Stack key={candidate.id} direction="row" alignItems="center" justifyContent="space-between" spacing={1} className="data-maintenance-row">
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="body2">{candidate.domain || candidate.table}</Typography>
                    <Typography variant="caption" color="text.secondary">{identity || candidate.table}</Typography>
                  </Box>
                  <Select
                    size="small"
                    displayEmpty
                    value={manualAssignments[candidate.id] || ''}
                    onChange={(event) => setManualAssignments((current) => ({ ...current, [candidate.id]: event.target.value }))}
                    inputProps={{ 'aria-label': `为 ${identity || candidate.table} 选择归属店铺` }}
                    sx={{ minWidth: 180 }}
                    MenuProps={STABLE_SELECT_MENU_PROPS}
                  >
                    <MenuItem value=""><em>暂不处理</em></MenuItem>
                    {manualShops.map((shop) => (
                      <MenuItem key={shop.id} value={shop.id}>
                        {shop.alias || shop.name || shop.id}（{shop.id}）
                      </MenuItem>
                    ))}
                  </Select>
                </Stack>
              );
            })}
          </Stack>
          {manualResolutionPreview?.truncated ? (
            <Alert severity="info" sx={{ mt: 1.5 }}>
              本页最多显示 {manualCandidates.length} 条；确认本页选择后，会自动刷新下一批候选。
            </Alert>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setManualConfirmOpen(false)} disabled={resolving}>取消</Button>
          <Button variant="contained" color="warning" onClick={confirmManualResolution} disabled={resolving || !manualAssignmentsToConfirm.length}>
            {resolving ? '归属处理中' : `确认归属 ${manualAssignmentsToConfirm.length} 条`}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
