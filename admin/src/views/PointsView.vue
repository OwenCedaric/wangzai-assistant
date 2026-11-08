<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { Coin, Delete, Edit, Plus, RefreshRight, SwitchButton, Tickets } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  pointLedgerApi,
  pointPackagesApi,
  pointWalletsApi,
  paidCapabilityRateCardsApi,
  paidCapabilityReconciliationsApi,
  apiPoolApi,
  productsApi,
  projectsApi,
} from '../api/admin.js'
import { getApiError } from '../api/response.js'
import PageHeader from '../components/common/PageHeader.vue'
import StatusBadge from '../components/common/StatusBadge.vue'
import PointPackageDialog from '../components/points/PointPackageDialog.vue'
import PointWalletAdjustDialog from '../components/points/PointWalletAdjustDialog.vue'
import PaidCapabilityRateCardDialog from '../components/points/PaidCapabilityRateCardDialog.vue'
import ImageModelPriceDialog from '../components/points/ImageModelPriceDialog.vue'
import RateMultiplierDialog from '../components/points/RateMultiplierDialog.vue'
import PaidCapabilityReconciliationDialog from '../components/points/PaidCapabilityReconciliationDialog.vue'
import { formatCentAmount, formatDateTime } from '../utils/formatters.js'

const activeTab = ref('packages')
const loading = ref(false)
const submitting = ref(false)
const projects = ref([])
const products = ref([])
const packages = ref([])
const wallets = ref([])
const ledger = ref([])
const rateCards = ref([])
const reconciliationJobs = ref([])
const apiProviders = ref([])
const apiModels = ref([])
const packageTotal = ref(0)
const walletTotal = ref(0)
const ledgerTotal = ref(0)
const packageDialog = ref(false)
const adjustDialog = ref(false)
const rateCardDialog = ref(false)
const imagePriceDialog = ref(false)
const reconciliationDialog = ref(false)
const multiplierDialog = ref(false)
const editingPackage = ref(null)
const selectedWallet = ref(null)
const selectedReconciliation = ref(null)
const selectedImageRate = ref(null)
const selectedMultiplierRate = ref(null)
const packageQuery = reactive({ project_id: '', product_id: '', q: '', status: '', page: 1, page_size: 50 })
const walletQuery = reactive({ project_id: '', q: '', page: 1, page_size: 50 })
const ledgerQuery = reactive({ project_id: '', wallet_id: '', event_type: '', page: 1, page_size: 50 })
const projectMap = computed(() => new Map(projects.value.map((item) => [item.id, item.name])))
const pageBalance = computed(() => wallets.value.reduce((sum, item) => sum + Number(item.available_points ?? item.balance_points ?? 0), 0))
const pageCredits = computed(() => wallets.value.reduce((sum, item) => sum + Number(item.lifetime_credited_points || 0), 0))
const activeImageRates = computed(() => rateCards.value.filter((item) => (
  item.status === 'active' && String(item.capability).startsWith('image.')
)))
const activeTextRates = computed(() => rateCards.value.filter((item) => item.status === 'active' && String(item.capability).startsWith('text.')))
const activeSfRates = computed(() => rateCards.value.filter((item) => item.status === 'active' && String(item.capability).startsWith('external.seerfar.')))

const eventLabels = {
  purchase_credit: '购买入账', spent: '业务消耗', expired: '积分到期',
  refund_reserved: '退款冻结', refund_restored: '退款恢复',
  admin_credit: '后台增加', admin_debit: '后台扣减',
  paid_capability_spent: '内置能力消耗',
}

async function loadOptions() {
  try {
    const [projectResult, productResult] = await Promise.all([
      projectsApi.list({ page: 1, page_size: 100 }),
      productsApi.list({ page: 1, page_size: 100 }),
    ])
    projects.value = projectResult.items
    products.value = productResult.items
  } catch (error) { ElMessage.error(getApiError(error, '项目与产品选项加载失败')) }
}
async function loadApiPoolOptions() {
  try {
    const providersResult = await apiPoolApi.providers()
    apiProviders.value = providersResult
    const modelGroups = await Promise.all(
      providersResult.map((provider) => apiPoolApi.models(provider.id)),
    )
    apiModels.value = modelGroups.flat()
  } catch (error) { ElMessage.error(getApiError(error, 'API 池选项加载失败')) }
}
async function loadPackages() {
  loading.value = true
  try { const result = await pointPackagesApi.list(packageQuery); packages.value = result.items; packageTotal.value = result.total }
  catch (error) { ElMessage.error(getApiError(error, '积分套餐加载失败')) } finally { loading.value = false }
}
async function loadWallets() {
  loading.value = true
  try { const result = await pointWalletsApi.list(walletQuery); wallets.value = result.items; walletTotal.value = result.total }
  catch (error) { ElMessage.error(getApiError(error, '积分钱包加载失败')) } finally { loading.value = false }
}
async function loadLedger() {
  loading.value = true
  try { const result = await pointLedgerApi.list(ledgerQuery); ledger.value = result.items; ledgerTotal.value = result.total }
  catch (error) { ElMessage.error(getApiError(error, '积分流水加载失败')) } finally { loading.value = false }
}
async function loadRateCards() {
  loading.value = true
  try { const result = await paidCapabilityRateCardsApi.list({}); rateCards.value = result.items }
  catch (error) { ElMessage.error(getApiError(error, '付费能力价格加载失败')) } finally { loading.value = false }
}
async function loadReconciliations() {
  loading.value = true
  try { const result = await paidCapabilityReconciliationsApi.list({ status: 'reconciliation_required' }); reconciliationJobs.value = result.items }
  catch (error) { ElMessage.error(getApiError(error, '待对账任务加载失败')) } finally { loading.value = false }
}
function loadActiveTab() {
  if (activeTab.value === 'packages') return loadPackages()
  if (activeTab.value === 'wallets') return loadWallets()
  if (['rate-cards', 'text-prices', 'image-prices', 'sf-prices'].includes(activeTab.value)) return loadRateCards()
  if (activeTab.value === 'reconciliations') return loadReconciliations()
  return loadLedger()
}
function searchPackages() { packageQuery.page = 1; loadPackages() }
function searchWallets() { walletQuery.page = 1; loadWallets() }
function searchLedger() { ledgerQuery.page = 1; loadLedger() }
function openPackage(item = null) { editingPackage.value = item; packageDialog.value = true }
async function savePackage(payload) {
  submitting.value = true
  try {
    if (editingPackage.value) await pointPackagesApi.update(editingPackage.value.id, payload)
    else await pointPackagesApi.create(payload)
    ElMessage.success('积分套餐已保存；开启在线销售后，旺崽助手会自动同步显示')
    packageDialog.value = false
    await loadPackages()
  } catch (error) { ElMessage.error(getApiError(error, '积分套餐保存失败')) } finally { submitting.value = false }
}
async function stopSales(item) {
  try {
    await ElMessageBox.confirm(`停售“${item.name}”后不再接受新订单，历史余额和流水不受影响。`, '停售积分套餐', { type: 'warning', confirmButtonText: '确认停售', cancelButtonText: '取消' })
    await pointPackagesApi.stopSales(item.id)
    ElMessage.success('积分套餐已停售')
    await loadPackages()
  } catch (error) { if (error !== 'cancel' && error !== 'close') ElMessage.error(getApiError(error, '停售失败')) }
}
async function removePackage(item) {
  try {
    await ElMessageBox.confirm(
      `永久删除积分套餐“${item.name}”？如已有订单，请先在订单页面删除相关订单。`,
      '永久删除积分套餐',
      { type: 'error', confirmButtonText: '永久删除', cancelButtonText: '取消' },
    )
    await pointPackagesApi.remove(item.id)
    ElMessage.success('积分套餐已删除')
    await loadPackages()
  } catch (error) { if (!['cancel', 'close'].includes(error)) ElMessage.error(getApiError(error, '积分套餐删除失败')) }
}
function openAdjustment(wallet) { selectedWallet.value = wallet; adjustDialog.value = true }
async function submitAdjustment(payload) {
  if (!selectedWallet.value) return
  submitting.value = true
  try {
    await pointWalletsApi.adjust(selectedWallet.value.wallet_id, payload)
    ElMessage.success(payload.operation === 'credit' ? '积分已增加' : '积分已扣减')
    adjustDialog.value = false
    await loadWallets()
  } catch (error) { ElMessage.error(getApiError(error, '积分调整失败')) } finally { submitting.value = false }
}
function showWalletLedger(wallet) {
  ledgerQuery.wallet_id = wallet.wallet_id
  ledgerQuery.project_id = wallet.project_id
  ledgerQuery.page = 1
  activeTab.value = 'ledger'
}
function clearLedgerWallet() { ledgerQuery.wallet_id = ''; ledgerQuery.page = 1; loadLedger() }
async function removeWallet(wallet) {
  try {
    await ElMessageBox.confirm(
      `永久删除 ${wallet.email || wallet.phone_masked || `用户 #${wallet.user_id}`} 的积分钱包？余额、有效期批次和全部流水会一起删除。`,
      '永久删除积分钱包',
      { type: 'error', confirmButtonText: '永久删除', cancelButtonText: '取消' },
    )
    await pointWalletsApi.remove(wallet.wallet_id)
    ElMessage.success('积分钱包及流水已删除')
    await Promise.all([loadWallets(), loadLedger()])
  } catch (error) { if (!['cancel', 'close'].includes(error)) ElMessage.error(getApiError(error, '积分钱包删除失败')) }
}
async function removeLedgerEntry(entry) {
  try {
    await ElMessageBox.confirm(
      '永久删除这条积分流水？该操作只清理流水记录，不会改动当前钱包余额。',
      '永久删除积分流水',
      { type: 'error', confirmButtonText: '永久删除', cancelButtonText: '取消' },
    )
    await pointLedgerApi.remove(entry.id)
    ElMessage.success('积分流水已删除')
    await loadLedger()
  } catch (error) { if (!['cancel', 'close'].includes(error)) ElMessage.error(getApiError(error, '积分流水删除失败')) }
}
async function createRateCard(payload) {
  submitting.value = true
  try {
    await paidCapabilityRateCardsApi.create(payload)
    ElMessage.success('付费能力价格版本已创建')
    rateCardDialog.value = false
    await loadRateCards()
  } catch (error) { ElMessage.error(getApiError(error, '价格版本创建失败')) } finally { submitting.value = false }
}
async function disableRateCard(item) {
  try {
    await ElMessageBox.confirm(`停用 ${item.capability} 的价格版本 ${item.price_version}？进行中的已预占任务不受影响。`, '停用价格版本', { type: 'warning', confirmButtonText: '确认停用', cancelButtonText: '取消' })
    await paidCapabilityRateCardsApi.disable(item.id)
    ElMessage.success('价格版本已停用')
    await loadRateCards()
  } catch (error) { if (!['cancel', 'close'].includes(error)) ElMessage.error(getApiError(error, '停用失败')) }
}
function openImagePrice(item) { selectedImageRate.value = item; imagePriceDialog.value = true }
async function saveImagePrice(payload) {
  if (!selectedImageRate.value) return
  submitting.value = true
  try {
    await paidCapabilityRateCardsApi.updateImagePrice(selectedImageRate.value.id, payload)
    ElMessage.success('生图价格已创建新版本并立即生效')
    imagePriceDialog.value = false
    selectedImageRate.value = null
    await loadRateCards()
  } catch (error) { ElMessage.error(getApiError(error, '生图价格保存失败')) } finally { submitting.value = false }
}
function openMultipliers(item) { selectedMultiplierRate.value = item; multiplierDialog.value = true }
async function saveMultipliers(payload) {
  if (!selectedMultiplierRate.value) return
  submitting.value = true
  try {
    await paidCapabilityRateCardsApi.updateMultipliers(selectedMultiplierRate.value.id, payload)
    ElMessage.success('倍率已创建新价格版本并立即生效')
    multiplierDialog.value = false
    selectedMultiplierRate.value = null
    await loadRateCards()
  } catch (error) { ElMessage.error(getApiError(error, '倍率保存失败')) } finally { submitting.value = false }
}
function openReconciliation(item) { selectedReconciliation.value = item; reconciliationDialog.value = true }
async function submitReconciliation(payload) {
  if (!selectedReconciliation.value) return
  submitting.value = true
  try {
    await paidCapabilityReconciliationsApi.reconcile(selectedReconciliation.value.id, payload)
    ElMessage.success(payload.decision === 'release_unbilled' ? '已确认未计费并释放积分' : '已按核实用量完成积分结算')
    reconciliationDialog.value = false
    selectedReconciliation.value = null
    await Promise.all([loadReconciliations(), loadWallets(), loadLedger()])
  } catch (error) { ElMessage.error(getApiError(error, '人工对账失败')) } finally { submitting.value = false }
}

function microsToCny(value) { return (Number(value || 0) / 1_000_000).toFixed(6).replace(/0+$/u, '').replace(/\.$/u, '') || '0' }
function basisPoints(value) { return `${(Number(value || 0) / 100).toFixed(2).replace(/\.00$/u, '')}%` }

watch(activeTab, () => loadActiveTab())
onMounted(async () => { await Promise.all([loadOptions(), loadApiPoolOptions(), loadPackages(), loadWallets(), loadRateCards(), loadReconciliations()]) })
</script>

<template>
  <div class="page-stack">
    <page-header title="积分管理" description="统一管理积分套餐、用户余额、有效期、调整记录和每一笔业务流水">
      <template #actions><el-button :icon="RefreshRight" :loading="loading" @click="loadActiveTab">刷新当前页</el-button></template>
    </page-header>
    <div class="metric-grid">
      <el-card shadow="never" class="metric-card"><span>钱包总数</span><strong>{{ walletTotal.toLocaleString('zh-CN') }}</strong><small>已创建的用户项目钱包</small></el-card>
      <el-card shadow="never" class="metric-card"><span>当前页可用积分</span><strong>{{ pageBalance.toLocaleString('zh-CN') }}</strong><small>按用户和项目隔离</small></el-card>
      <el-card shadow="never" class="metric-card"><span>当前页累计入账</span><strong>{{ pageCredits.toLocaleString('zh-CN') }}</strong><small>购买与后台补发合计</small></el-card>
    </div>
    <el-card shadow="never" class="surface-card">
      <el-tabs v-model="activeTab">
        <el-tab-pane label="积分套餐" name="packages">
          <div class="toolbar tab-toolbar">
            <div class="toolbar__filters">
              <el-input v-model="packageQuery.q" clearable placeholder="套餐名称" style="width:190px" @keyup.enter="searchPackages" @clear="searchPackages" />
              <el-select v-model="packageQuery.project_id" clearable placeholder="全部项目" style="width:170px" @change="searchPackages"><el-option v-for="item in projects" :key="item.id" :label="item.name" :value="item.id" /></el-select>
              <el-select v-model="packageQuery.status" clearable placeholder="全部状态" style="width:130px" @change="searchPackages"><el-option label="正常" value="active" /><el-option label="停用" value="disabled" /></el-select>
              <el-button type="primary" @click="searchPackages">查询</el-button>
            </div>
            <el-button type="primary" :icon="Plus" :disabled="!products.length" @click="openPackage()">新增积分套餐</el-button>
          </div>
          <el-table v-loading="loading" :data="packages" stripe>
            <el-table-column label="套餐" min-width="180"><template #default="{ row }"><div class="primary-cell"><strong>{{ row.name }}</strong><span>{{ row.customer_description || '未填写用户说明' }}</span></div></template></el-table-column>
            <el-table-column label="所属项目 / 产品" min-width="180"><template #default="{ row }">{{ projectMap.get(row.project_id) || row.project_code }}<br /><span class="muted">{{ row.product_name }}</span></template></el-table-column>
            <el-table-column label="积分与售价" width="160"><template #default="{ row }"><strong>{{ Number(row.points_amount).toLocaleString('zh-CN') }} 积分</strong><br /><span class="muted">{{ formatCentAmount(row.sale_price_cent, row.currency) }}</span></template></el-table-column>
            <el-table-column label="有效期" width="90"><template #default="{ row }">{{ row.validity_days }} 天</template></el-table-column>
            <el-table-column label="销售" width="115"><template #default="{ row }"><el-tag :type="row.online_sale_enabled ? 'success' : 'info'" effect="plain">{{ row.online_sale_enabled ? '在售' : '停售' }}</el-tag><el-tag v-if="row.featured" type="warning" effect="plain" class="featured-tag">推荐</el-tag></template></el-table-column>
            <el-table-column label="状态" width="90"><template #default="{ row }"><status-badge :status="row.status" /></template></el-table-column>
            <el-table-column label="操作" width="282" fixed="right"><template #default="{ row }"><div class="table-actions"><el-button text type="primary" :icon="Edit" @click="openPackage(row)">编辑</el-button><el-button v-if="row.online_sale_enabled" text type="warning" :icon="SwitchButton" @click="stopSales(row)">停售</el-button><el-button text type="danger" :icon="Delete" @click="removePackage(row)">删除</el-button></div></template></el-table-column>
            <template #empty><el-empty description="暂无积分套餐" /></template>
          </el-table>
          <div class="table-pagination"><el-pagination v-model:current-page="packageQuery.page" v-model:page-size="packageQuery.page_size" background layout="total, sizes, prev, pager, next" :total="packageTotal" @change="loadPackages" /></div>
        </el-tab-pane>
        <el-tab-pane label="用户钱包" name="wallets">
          <div class="toolbar tab-toolbar"><div class="toolbar__filters"><el-input v-model="walletQuery.q" clearable placeholder="注册邮箱 / 手机" style="width:240px" @keyup.enter="searchWallets" @clear="searchWallets" /><el-select v-model="walletQuery.project_id" clearable placeholder="全部项目" style="width:170px" @change="searchWallets"><el-option v-for="item in projects" :key="item.id" :label="item.name" :value="item.id" /></el-select><el-button type="primary" @click="searchWallets">查询</el-button></div></div>
          <el-table v-loading="loading" :data="wallets" stripe>
            <el-table-column label="用户" min-width="220"><template #default="{ row }"><div class="primary-cell"><strong>{{ row.email || row.phone_masked || `用户 #${row.user_id}` }}</strong><span>{{ row.email ? '注册邮箱' : '账号标识' }}</span></div></template></el-table-column>
            <el-table-column label="项目" min-width="140"><template #default="{ row }">{{ projectMap.get(row.project_id) || row.project_code }}</template></el-table-column>
            <el-table-column label="可用 / 预占" width="165"><template #default="{ row }"><strong class="points-balance">{{ Number(row.available_points ?? row.balance_points).toLocaleString('zh-CN') }}</strong> / {{ Number(row.reserved_points || 0).toLocaleString('zh-CN') }}</template></el-table-column>
            <el-table-column label="累计入账 / 消耗" width="180"><template #default="{ row }">+{{ Number(row.lifetime_credited_points).toLocaleString('zh-CN') }} / -{{ Number(row.lifetime_spent_points).toLocaleString('zh-CN') }}</template></el-table-column>
            <el-table-column label="最近到期" width="180"><template #default="{ row }"><span v-if="row.next_expiry">{{ formatDateTime(row.next_expiry) }}<br /><span class="muted">{{ row.next_expiring_points }} 积分</span></span><span v-else class="muted">暂无</span></template></el-table-column>
            <el-table-column label="操作" width="282" fixed="right"><template #default="{ row }"><div class="table-actions"><el-button text type="primary" :icon="Coin" @click="openAdjustment(row)">调整</el-button><el-button text type="primary" :icon="Tickets" @click="showWalletLedger(row)">流水</el-button><el-button text type="danger" :icon="Delete" @click="removeWallet(row)">删除</el-button></div></template></el-table-column>
            <template #empty><el-empty description="暂无积分钱包" /></template>
          </el-table>
          <div class="table-pagination"><el-pagination v-model:current-page="walletQuery.page" v-model:page-size="walletQuery.page_size" background layout="total, sizes, prev, pager, next" :total="walletTotal" @change="loadWallets" /></div>
        </el-tab-pane>
        <el-tab-pane label="积分流水" name="ledger">
          <div class="toolbar tab-toolbar"><div class="toolbar__filters"><el-select v-model="ledgerQuery.project_id" clearable placeholder="全部项目" style="width:170px" @change="searchLedger"><el-option v-for="item in projects" :key="item.id" :label="item.name" :value="item.id" /></el-select><el-select v-model="ledgerQuery.event_type" clearable placeholder="全部流水类型" style="width:170px" @change="searchLedger"><el-option v-for="(label, value) in eventLabels" :key="value" :label="label" :value="value" /></el-select><el-tag v-if="ledgerQuery.wallet_id" closable type="primary" effect="plain" @close="clearLedgerWallet">钱包 #{{ ledgerQuery.wallet_id }}</el-tag><el-button type="primary" @click="searchLedger">查询</el-button></div></div>
          <el-table v-loading="loading" :data="ledger" stripe>
            <el-table-column label="时间" width="170"><template #default="{ row }">{{ formatDateTime(row.created_at) }}</template></el-table-column>
            <el-table-column label="用户 / 钱包" width="145"><template #default="{ row }">用户 #{{ row.user_id }}<br /><span class="muted">钱包 #{{ row.wallet_id }}</span></template></el-table-column>
            <el-table-column label="类型" width="120"><template #default="{ row }">{{ eventLabels[row.event_type] || row.event_type }}</template></el-table-column>
            <el-table-column label="变动" width="125"><template #default="{ row }"><strong :class="row.delta_points > 0 ? 'delta-plus' : 'delta-minus'">{{ row.delta_points > 0 ? '+' : '' }}{{ Number(row.delta_points).toLocaleString('zh-CN') }}</strong></template></el-table-column>
            <el-table-column label="变动后余额" width="130"><template #default="{ row }">{{ Number(row.balance_after).toLocaleString('zh-CN') }}</template></el-table-column>
            <el-table-column prop="reason" label="原因" min-width="200" show-overflow-tooltip />
            <el-table-column label="关联" min-width="150"><template #default="{ row }">{{ row.reference_type || '—' }}<span v-if="row.reference_id"> · {{ row.reference_id }}</span></template></el-table-column>
            <el-table-column label="操作" width="110" fixed="right"><template #default="{ row }"><el-button text type="danger" :icon="Delete" @click="removeLedgerEntry(row)">删除</el-button></template></el-table-column>
            <template #empty><el-empty description="暂无积分流水" /></template>
          </el-table>
          <div class="table-pagination"><el-pagination v-model:current-page="ledgerQuery.page" v-model:page-size="ledgerQuery.page_size" background layout="total, sizes, prev, pager, next" :total="ledgerTotal" @change="loadLedger" /></div>
        </el-tab-pane>
        <el-tab-pane label="生图模型价格" name="image-prices">
          <div class="toolbar tab-toolbar">
            <div class="toolbar__filters"><el-alert title="这里只管理内置积分通道；用户自带 API 不扣积分。调整会创建新版本，不会修改历史任务。" type="info" :closable="false" show-icon /></div>
          </div>
          <el-table v-loading="loading" :data="activeImageRates" stripe>
            <el-table-column label="模型 / 能力" min-width="240"><template #default="{ row }"><div class="primary-cell"><strong>{{ row.provider_model }}</strong><span>{{ row.capability }}</span></div></template></el-table-column>
            <el-table-column label="项目" min-width="130"><template #default="{ row }">{{ projectMap.get(row.project_id) || `#${row.project_id}` }}</template></el-table-column>
            <el-table-column label="内部成本" width="135"><template #default="{ row }"><strong>¥{{ microsToCny(row.unit_cost_micros) }}</strong> / 张</template></el-table-column>
            <el-table-column label="用户价格" width="135"><template #default="{ row }"><strong class="points-balance">¥{{ microsToCny(row.unit_sell_price_micros) }}</strong> / 张</template></el-table-column>
            <el-table-column label="每张扣除" width="120"><template #default="{ row }">{{ Math.ceil(row.unit_sell_price_micros * row.points_per_cny / 1_000_000) }} 积分</template></el-table-column>
            <el-table-column label="成本 / 扣费倍率" width="145"><template #default="{ row }">{{ basisPoints(row.provider_multiplier_ppm / 100) }} / {{ basisPoints(row.customer_multiplier_ppm / 100) }}</template></el-table-column>
            <el-table-column label="价格版本" min-width="220"><template #default="{ row }"><span class="muted">{{ row.price_version }}</span></template></el-table-column>
            <el-table-column label="操作" width="196" fixed="right"><template #default="{ row }"><el-button text type="primary" :icon="Edit" @click="openImagePrice(row)">价格</el-button><el-button text type="primary" @click="openMultipliers(row)">倍率</el-button></template></el-table-column>
            <template #empty><el-empty description="暂无生图价格；请先在付费能力价格中创建图片模型价格" /></template>
          </el-table>
        </el-tab-pane>
        <el-tab-pane label="文本模型价格" name="text-prices">
          <el-alert title="内置文本模型按上游真实扣费结算，用户最终扣费固定为上游成本的 1.2 倍；用户自带接口不扣积分。" type="info" :closable="false" show-icon class="reconciliation-alert" />
          <el-table v-loading="loading" :data="activeTextRates" stripe>
            <el-table-column label="模型 / 能力" min-width="250"><template #default="{ row }"><div class="primary-cell"><strong>{{ row.provider_model }}</strong><span>{{ row.capability }}</span></div></template></el-table-column>
            <el-table-column label="Token 基础成本" min-width="220"><template #default="{ row }">输入 ¥{{ microsToCny(row.input_micros_per_million) }}<br />输出 ¥{{ microsToCny(row.output_micros_per_million) }} / 百万</template></el-table-column>
            <el-table-column label="成本倍率" width="120"><template #default="{ row }">{{ (row.provider_multiplier_ppm / 10000).toFixed(2) }}%</template></el-table-column>
            <el-table-column label="用户扣费倍率" width="140"><template #default="{ row }"><strong>{{ (row.customer_multiplier_ppm / 10000).toFixed(2) }}%</strong></template></el-table-column>
            <el-table-column label="结算规则" width="150"><template #default="{ row }"><strong>{{ row.target_margin_basis_points === 0 && row.customer_multiplier_ppm === 1200000 ? '上游成本 × 1.2' : `目标毛利 ${basisPoints(row.target_margin_basis_points)}` }}</strong></template></el-table-column>
            <el-table-column label="操作" width="110" fixed="right"><template #default="{ row }"><el-button text type="primary" :icon="Edit" @click="openMultipliers(row)">调整倍率</el-button></template></el-table-column>
          </el-table>
        </el-tab-pane>
        <el-tab-pane label="SF 数据查询" name="sf-prices">
          <el-alert title="SF 每个查询接口独立计价；成本倍率和用户扣费倍率调整后立即生成新版本。" type="info" :closable="false" show-icon class="reconciliation-alert" />
          <el-table v-loading="loading" :data="activeSfRates" stripe>
            <el-table-column label="SF 查询能力" min-width="280"><template #default="{ row }"><div class="primary-cell"><strong>SF 数据查询</strong><span>{{ row.capability }}</span></div></template></el-table-column>
            <el-table-column label="单次基础成本" width="150"><template #default="{ row }">¥{{ microsToCny(row.unit_cost_micros) }}</template></el-table-column>
            <el-table-column label="成本倍率" width="120"><template #default="{ row }">{{ (row.provider_multiplier_ppm / 10000).toFixed(2) }}%</template></el-table-column>
            <el-table-column label="用户扣费倍率" width="140"><template #default="{ row }"><strong>{{ (row.customer_multiplier_ppm / 10000).toFixed(2) }}%</strong></template></el-table-column>
            <el-table-column label="预计单次扣费" width="145"><template #default="{ row }">约 {{ Math.ceil(row.unit_cost_micros * row.provider_multiplier_ppm / 1_000_000 * row.points_per_cny / 1_000_000 / (1 - row.target_margin_basis_points / 10000) * row.customer_multiplier_ppm / 1_000_000) }} 积分</template></el-table-column>
            <el-table-column label="操作" width="110" fixed="right"><template #default="{ row }"><el-button text type="primary" :icon="Edit" @click="openMultipliers(row)">调整倍率</el-button></template></el-table-column>
          </el-table>
        </el-tab-pane>
        <el-tab-pane label="付费能力价格" name="rate-cards">
          <div class="toolbar tab-toolbar"><div class="toolbar__filters"><el-alert title="成本只保存在服务端；毛利底线固定 15%，建议目标 18%。" type="info" :closable="false" show-icon /></div><el-button type="primary" :icon="Plus" :disabled="!projects.length" @click="rateCardDialog = true">新增价格版本</el-button></div>
          <el-table v-loading="loading" :data="rateCards" stripe>
            <el-table-column label="能力 / 版本" min-width="250"><template #default="{ row }"><div class="primary-cell"><strong>{{ row.capability }}</strong><span>{{ row.price_version }} · v{{ row.version }}</span></div></template></el-table-column>
            <el-table-column label="项目" min-width="130"><template #default="{ row }">{{ projectMap.get(row.project_id) || `#${row.project_id}` }}</template></el-table-column>
            <el-table-column label="供应商 / 模型" min-width="170"><template #default="{ row }">{{ row.provider_code }}<br /><span class="muted">{{ row.provider_model || '按次查询' }}</span></template></el-table-column>
            <el-table-column label="成本 / 固定售价" min-width="190"><template #default="{ row }"><span v-if="row.input_micros_per_million">输入 ¥{{ microsToCny(row.input_micros_per_million) }}/百万</span><span v-if="row.output_micros_per_million"><br />输出 ¥{{ microsToCny(row.output_micros_per_million) }}/百万</span><span v-if="row.unit_cost_micros"><br />单位成本 ¥{{ microsToCny(row.unit_cost_micros) }}</span><span v-if="row.unit_sell_price_micros"><br /><strong>用户价 ¥{{ microsToCny(row.unit_sell_price_micros) }}</strong></span><span v-if="row.fixed_cost_micros"><br />固定 ¥{{ microsToCny(row.fixed_cost_micros) }}</span></template></el-table-column>
            <el-table-column label="缓冲 / 毛利" width="135"><template #default="{ row }">{{ basisPoints(row.risk_buffer_basis_points) }} / <strong>{{ basisPoints(row.target_margin_basis_points) }}</strong></template></el-table-column>
            <el-table-column label="积分汇率" width="115"><template #default="{ row }">{{ row.points_per_cny }}/元</template></el-table-column>
            <el-table-column label="生效时间" min-width="185"><template #default="{ row }">{{ formatDateTime(row.effective_from) }}<br /><span class="muted">至 {{ row.effective_until ? formatDateTime(row.effective_until) : '长期' }}</span></template></el-table-column>
            <el-table-column label="状态" width="90"><template #default="{ row }"><status-badge :status="row.status" /></template></el-table-column>
            <el-table-column label="操作" width="110" fixed="right"><template #default="{ row }"><el-button v-if="row.status === 'active'" text type="warning" :icon="SwitchButton" @click="disableRateCard(row)">停用</el-button></template></el-table-column>
            <template #empty><el-empty description="暂无价格版本；未配置时付费能力会安全拒绝，不会调用上游" /></template>
          </el-table>
        </el-tab-pane>
        <el-tab-pane :label="`待人工对账${reconciliationJobs.length ? ` (${reconciliationJobs.length})` : ''}`" name="reconciliations">
          <el-alert title="这里仅显示供应商调用结果未知、积分仍被预占的任务。必须先去供应商后台核实账单，再选择释放或结算。系统绝不自动退款。" type="warning" :closable="false" show-icon class="reconciliation-alert" />
          <el-table v-loading="loading" :data="reconciliationJobs" stripe>
            <el-table-column label="任务 / 能力" min-width="280"><template #default="{ row }"><div class="primary-cell"><strong>{{ row.capability }}</strong><span>{{ row.id }}</span></div></template></el-table-column>
            <el-table-column label="用户 / 项目" width="150"><template #default="{ row }">用户 #{{ row.user_id }}<br /><span class="muted">{{ projectMap.get(row.project_id) || `项目 #${row.project_id}` }}</span></template></el-table-column>
            <el-table-column label="预占积分" width="120"><template #default="{ row }"><strong>{{ Number(row.reserved_points || 0).toLocaleString('zh-CN') }}</strong></template></el-table-column>
            <el-table-column prop="error_code" label="错误码" min-width="230" show-overflow-tooltip />
            <el-table-column label="发生时间" width="180"><template #default="{ row }">{{ formatDateTime(row.completed_at || row.accepted_at) }}</template></el-table-column>
            <el-table-column label="操作" width="130" fixed="right"><template #default="{ row }"><el-button text type="danger" @click="openReconciliation(row)">核对并处理</el-button></template></el-table-column>
            <template #empty><el-empty description="当前没有待人工对账任务" /></template>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </el-card>
    <point-package-dialog v-model="packageDialog" :package-item="editingPackage" :products="products" :submitting="submitting" @submit="savePackage" />
    <point-wallet-adjust-dialog v-model="adjustDialog" :wallet="selectedWallet" :submitting="submitting" @submit="submitAdjustment" />
    <paid-capability-rate-card-dialog v-model="rateCardDialog" :projects="projects" :api-providers="apiProviders" :api-models="apiModels" :submitting="submitting" @submit="createRateCard" />
    <image-model-price-dialog v-model="imagePriceDialog" :rate="selectedImageRate" :submitting="submitting" @submit="saveImagePrice" />
    <rate-multiplier-dialog v-model="multiplierDialog" :rate="selectedMultiplierRate" :submitting="submitting" @submit="saveMultipliers" />
    <paid-capability-reconciliation-dialog v-model="reconciliationDialog" :job="selectedReconciliation" :submitting="submitting" @submit="submitReconciliation" />
  </div>
</template>

<style scoped>
.metric-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.metric-card :deep(.el-card__body){display:flex;flex-direction:column;gap:7px}.metric-card span,.metric-card small,.primary-cell span,.muted{color:var(--lc-muted)}.metric-card strong{font-size:26px;color:#172033}.tab-toolbar{min-height:44px;margin-bottom:15px}.primary-cell{display:flex;flex-direction:column;gap:5px}.primary-cell span{font-size:12px}.featured-tag{margin-left:5px}.points-balance{font-size:18px;color:#315efb}.delta-plus{color:#168766}.delta-minus{color:#d14343}.reconciliation-alert{margin-bottom:16px}@media(max-width:850px){.metric-grid{grid-template-columns:1fr}}
</style>
