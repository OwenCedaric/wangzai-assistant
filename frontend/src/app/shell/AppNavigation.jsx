import AccountBalanceWalletRounded from '@mui/icons-material/AccountBalanceWalletRounded';
import AnalyticsRounded from '@mui/icons-material/AnalyticsRounded';
import BackupRounded from '@mui/icons-material/BackupRounded';
import CampaignRounded from '@mui/icons-material/CampaignRounded';
import ChevronLeftRounded from '@mui/icons-material/ChevronLeftRounded';
import CloseRounded from '@mui/icons-material/CloseRounded';
import DashboardRounded from '@mui/icons-material/DashboardRounded';
import ExtensionRounded from '@mui/icons-material/ExtensionRounded';
import GppGoodRounded from '@mui/icons-material/GppGoodRounded';
import Inventory2Rounded from '@mui/icons-material/Inventory2Rounded';
import KeyboardArrowDownRounded from '@mui/icons-material/KeyboardArrowDownRounded';
import LocalOfferRounded from '@mui/icons-material/LocalOfferRounded';
import PriceCheckRounded from '@mui/icons-material/PriceCheckRounded';
import ShoppingCartCheckoutRounded from '@mui/icons-material/ShoppingCartCheckoutRounded';
import StarsRounded from '@mui/icons-material/StarsRounded';
import SupportAgentRounded from '@mui/icons-material/SupportAgentRounded';
import WarehouseRounded from '@mui/icons-material/WarehouseRounded';
import Box from '@mui/material/Box';
import Collapse from '@mui/material/Collapse';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import React from 'react';

export const navGroups = [
  {
    title: '',
    items: [
      { id: 'dashboard', label: '旺崽汇总', icon: <DashboardRounded /> },
      { id: 'products', label: '商品列表', icon: <Inventory2Rounded /> },
      {
        id: 'orders',
        label: '订单管理',
        icon: <ShoppingCartCheckoutRounded />,
        children: [
          { id: 'sales-orders', label: '销售订单' },
          { id: 'purchase-orders', label: '拍单管理' },
          { id: 'after-sales-orders', label: '售后订单' },
          { id: 'pending-orders', label: '待处理单' },
          { id: 'print-shipping', label: '打单发货' },
          { id: 'purchase-rehearsal', label: '自动拍单' },
        ],
      },
      {
        id: 'profit-accounting',
        label: '利润核算',
        icon: <AccountBalanceWalletRounded />,
        children: [
          { id: 'shipping', label: '订单利润' },
          { id: 'profit-report', label: '利润报表' },
        ],
      },
      { id: 'inventory', label: '营销活动', icon: <LocalOfferRounded /> },
      { id: 'paid-promotion', label: '付费推广', icon: <CampaignRounded /> },
      { id: 'data-analysis', label: '数据分析', icon: <AnalyticsRounded /> },
      { id: 'prompt-library', label: '智能工具', icon: <ExtensionRounded /> },
      { id: 'collection-pricing', label: '采集核价', icon: <PriceCheckRounded /> },
      { id: 'points-packages', label: '积分套餐', icon: <StarsRounded /> },
      { id: 'follow-seller-defense', label: '剔除跟卖', icon: <GppGoodRounded /> },
      {
        id: 'customer-service',
        label: '客服咨询',
        icon: <SupportAgentRounded />,
        children: [
          { id: 'customer-consultation', label: '在线客服' },
          { id: 'smart-reply', label: '智能回复' },
        ],
      },
      { id: 'warehouse-logistics', label: '仓储物流', icon: <WarehouseRounded /> },
      { id: 'data-backup', label: '数据备份', icon: <BackupRounded /> },
    ],
  },
];

export function getSidebarPageConfig(pageId) {
  for (const group of navGroups) {
    for (const item of group.items) {
      if (item.disabled) continue;
      if (!item.children && item.id === pageId) {
        return {
          id: item.id,
          label: item.label,
          icon: item.icon,
        };
      }
      const child = item.children?.find((childItem) => childItem.id === pageId);
      if (child) {
        return {
          id: child.id,
          label: child.label,
          icon: item.icon,
        };
      }
    }
  }

  return null;
}

export function createWorkspaceTab(pageId) {
  const pageConfig = getSidebarPageConfig(pageId);
  if (!pageConfig) return null;

  return {
    ...pageConfig,
    fixed: pageConfig.id === 'dashboard',
  };
}

export function deduplicateWorkspaceTabs(tabs = []) {
  const seen = new Set();
  return (Array.isArray(tabs) ? tabs : []).filter((tab) => {
    const id = String(tab?.id || '').trim();
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function appendWorkspaceTabUnique(tabs = [], nextTab = null) {
  const current = deduplicateWorkspaceTabs(tabs);
  const nextId = String(nextTab?.id || '').trim();
  if (!nextId || current.some((tab) => tab.id === nextId)) {
    return Array.isArray(tabs) && current.length === tabs.length ? tabs : current;
  }
  return [...current, nextTab];
}

export function isTabOutsideHorizontalViewport(tabRect = {}, containerRect = {}) {
  return Number(tabRect.left) < Number(containerRect.left) || Number(tabRect.right) > Number(containerRect.right);
}

export function WorkspaceTabs({ tabs, currentPage, onSelect, onClose }) {
  const tabRefs = React.useRef(new Map());
  const tabsRef = React.useRef(null);

  React.useEffect(() => {
    const activeTab = tabRefs.current.get(currentPage);
    const tabList = tabsRef.current;
    if (!activeTab || !tabList) return undefined;
    const scrollActiveTabInsideTabList = () => {
      const activeRect = activeTab.getBoundingClientRect();
      const tabListRect = tabList.getBoundingClientRect();
      if (!isTabOutsideHorizontalViewport(activeRect, tabListRect)) return;

      const offset = activeRect.left < tabListRect.left
        ? activeRect.left - tabListRect.left
        : activeRect.right - tabListRect.right;
      const nextScrollLeft = Math.max(0, tabList.scrollLeft + offset);
      if (typeof tabList.scrollTo === 'function') {
        tabList.scrollTo({ left: nextScrollLeft, behavior: 'smooth' });
      } else {
        tabList.scrollLeft = nextScrollLeft;
      }
    };
    if (typeof window !== 'undefined' && typeof window.IntersectionObserver === 'function') {
      const observer = new window.IntersectionObserver(
        (entries) => {
          const entry = entries[0];
          observer.disconnect();
          if (!entry || entry.intersectionRatio >= 0.99) return;
          scrollActiveTabInsideTabList();
        },
        { root: tabList, threshold: 0.99 }
      );
      observer.observe(activeTab);
      return () => observer.disconnect();
    }
    const ensureActiveTabVisible = () => {
      if (!isTabOutsideHorizontalViewport(activeTab.getBoundingClientRect(), tabList.getBoundingClientRect())) return;
      scrollActiveTabInsideTabList();
    };
    // Legacy fallback only. It moves the horizontal tab strip itself, so the
    // active business page cannot jump.
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      const frameId = window.requestAnimationFrame(ensureActiveTabVisible);
      return () => window.cancelAnimationFrame(frameId);
    }
    const timer = globalThis.setTimeout(ensureActiveTabVisible, 0);
    return () => globalThis.clearTimeout(timer);
  }, [currentPage, tabs.length]);

  return (
    <Box className="workspace-tabs-shell" aria-label="已打开页面">
      <Stack ref={tabsRef} direction="row" alignItems="center" spacing={1} className="workspace-tabs">
        {tabs.map((tab) => {
          const isActive = currentPage === tab.id;
          return (
            <Box
              key={tab.id}
              ref={(node) => {
                if (node) tabRefs.current.set(tab.id, node);
                else tabRefs.current.delete(tab.id);
              }}
              className={`workspace-tab${isActive ? ' active' : ''}${tab.fixed ? ' fixed' : ''}`}
            >
              <Box
                component="button"
                type="button"
                className="workspace-tab-main"
                onClick={() => onSelect(tab.id)}
                aria-current={isActive ? 'page' : undefined}
              >
                <Box className="workspace-tab-icon">{tab.icon}</Box>
                <span>{tab.label}</span>
              </Box>
              {!tab.fixed ? (
                <Tooltip title="关闭标签">
                  <IconButton
                    size="small"
                    className="workspace-tab-close"
                    aria-label={`关闭 ${tab.label}`}
                    onClick={() => onClose(tab.id)}
                  >
                    <CloseRounded />
                  </IconButton>
                </Tooltip>
              ) : null}
            </Box>
          );
        })}
      </Stack>
    </Box>
  );
}

export function Sidebar({ currentPage, open, onClose, onNavigate }) {
  const [expandedGroups, setExpandedGroups] = React.useState({ orders: true });
  const [buildIdentity, setBuildIdentity] = React.useState(null);

  React.useEffect(() => {
    let active = true;
    const getAppInfo = globalThis.window?.wangzaiDesktop?.getAppInfo;
    if (typeof getAppInfo !== 'function') return () => { active = false; };
    Promise.resolve(getAppInfo())
      .then((info) => {
        if (active && info?.buildIdentity) setBuildIdentity(info.buildIdentity);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  React.useEffect(() => {
    const activeParent = navGroups
      .flatMap((group) => group.items)
      .find((item) => item.children?.some((child) => child.id === currentPage));
    if (!activeParent) return;
    setExpandedGroups((current) =>
      current[activeParent.id]
        ? current
        : {
            ...current,
            [activeParent.id]: true,
          }
    );
  }, [currentPage]);

  const toggleGroup = (id) => {
    setExpandedGroups((current) => ({
      ...current,
      [id]: !current[id],
    }));
  };

  const runtimeLabel = buildIdentity?.runtimeMode === 'source'
    ? '当前源码'
    : buildIdentity?.runtimeMode === 'packaged'
      ? '正式构建'
      : '';
  const versionCaption = [buildIdentity?.displayVersion || '5.0 当前版', runtimeLabel]
    .filter(Boolean)
    .join(' · ');
  const versionDetail = [
    buildIdentity?.windowTitle || '旺崽助手 · 5.0 当前版',
    buildIdentity?.frontendBuildTime ? `构建时间：${buildIdentity.frontendBuildTime}` : '',
    buildIdentity?.sourceRoot ? `源码：${buildIdentity.sourceRoot}` : '',
  ].filter(Boolean).join('\n');

  const content = (
    <Box className={`sidebar-shell${open ? ' is-expanded' : ' is-collapsed'}`}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" className="brand-row">
        <Stack direction="row" alignItems="center" spacing={1.1} className="brand-identity">
          <Box component="img" className="brand-logo" src="/favicon.png" alt="旺崽助手" />
          <Box className="brand-copy">
            <Typography variant="h6">旺崽助手</Typography>
            <Tooltip title={<span style={{ whiteSpace: 'pre-line' }}>{versionDetail}</span>} placement="right">
              <Typography variant="caption" color="text.secondary">
                Ozon 运营中台 · {versionCaption}
              </Typography>
            </Tooltip>
          </Box>
        </Stack>
        <IconButton
          className="sidebar-collapse-button"
          onClick={onClose}
          aria-label="收起导航栏"
        >
          <ChevronLeftRounded />
        </IconButton>
      </Stack>

      <List disablePadding className="sidebar-navigation">
        {navGroups.map((group, groupIndex) => (
          <Box key={group.title || `group-${groupIndex}`} className="nav-group">
            {group.items.map((item) => {
              const isExpanded = Boolean(expandedGroups[item.id]);
              const subnavId = `sidebar-subnav-${item.id}`;
              const menuButton = (
                <ListItemButton
                  disableRipple
                  selected={
                    currentPage === item.id || Boolean(item.children?.some((child) => child.id === currentPage))
                  }
                  disabled={item.disabled}
                  className={`nav-item${item.children ? ' nav-parent' : ''}`}
                  aria-expanded={item.children && open ? isExpanded : undefined}
                  aria-controls={item.children && open ? subnavId : undefined}
                  onClick={() => {
                    if (item.children) {
                      if (!open) {
                        return;
                      }
                      toggleGroup(item.id);
                    } else if (!item.disabled) {
                      onNavigate(item.id);
                    }
                  }}
                >
                  <ListItemIcon>{item.icon}</ListItemIcon>
                  <ListItemText primary={item.label} />
                  {item.children && open ? (
                    <KeyboardArrowDownRounded
                      className={`nav-expand-icon${isExpanded ? ' is-expanded' : ''}`}
                      aria-hidden="true"
                    />
                  ) : null}
                </ListItemButton>
              );
              return (
                <Box key={item.id}>
                  <Tooltip title={open ? '' : item.label} placement="right" arrow disableInteractive>
                    {menuButton}
                  </Tooltip>
                  {item.children && open ? (
                    <Collapse
                      in={isExpanded}
                      timeout={220}
                      easing={{ enter: 'cubic-bezier(0.22, 1, 0.36, 1)', exit: 'cubic-bezier(0.4, 0, 1, 1)' }}
                      unmountOnExit
                    >
                      <Box id={subnavId} className="subnav-list">
                        {item.children.map((child) => (
                          <Box
                            key={child.id}
                            component="button"
                            type="button"
                            disabled={child.disabled}
                            className={`subnav-item${currentPage === child.id ? ' active' : ''}`}
                            onClick={() => {
                              if (!child.disabled) onNavigate(child.id);
                            }}
                          >
                            {child.label}
                          </Box>
                        ))}
                      </Box>
                    </Collapse>
                  ) : null}
                </Box>
              );
            })}
          </Box>
        ))}
      </List>
    </Box>
  );

  return (
    <Drawer
      variant="permanent"
      className={`app-drawer${open ? ' is-expanded' : ' is-collapsed'}`}
      PaperProps={{ className: `drawer-paper${open ? ' is-expanded' : ' is-collapsed'}` }}
    >
      {content}
    </Drawer>
  );
}
