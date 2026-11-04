import LogoutRounded from '@mui/icons-material/LogoutRounded';
import PersonOutlineRounded from '@mui/icons-material/PersonOutlineRounded';
import Avatar from '@mui/material/Avatar';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Tooltip from '@mui/material/Tooltip';
import React from 'react';
import { useDesktopAuth } from '../model/DesktopAuthContext.jsx';
import { DesktopUiUpdateDialog } from './DesktopUiUpdate.jsx';
import { useDesktopUiUpdate } from '../model/useDesktopUiUpdate.js';

function accountInitial(user) {
  const name = String(user?.email || user?.username || '').trim();
  return name ? name.slice(0, 2).toUpperCase() : 'WZ';
}

export function DesktopAccountMenu() {
  const updates = useDesktopUiUpdate();
  const { session, logout } = useDesktopAuth();
  const [anchorEl, setAnchorEl] = React.useState(null);
  const user = session?.user || null;
  const close = () => setAnchorEl(null);

  const handleLogout = async () => {
    close();
    await logout();
  };

  return (
    <>
      <Tooltip title="账户">
        <IconButton
          size="small"
          aria-label="打开账户菜单"
          onClick={(event) => setAnchorEl(event.currentTarget)}
        >
          <Avatar className="user-avatar">{accountInitial(user)}</Avatar>
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={close}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { minWidth: 210, mt: 0.8, borderRadius: 1.5 } } }}
      >
        <MenuItem disabled sx={{ opacity: '1 !important', alignItems: 'flex-start' }}>
          <ListItemIcon><PersonOutlineRounded fontSize="small" /></ListItemIcon>
          <span>
            <strong style={{ display: 'block', color: '#172033' }}>{user?.email || '当前账户'}</strong>
            <small style={{ color: '#7a8497' }}>已登录</small>
          </span>
        </MenuItem>
        <Divider />
        {updates.enabled ? <MenuItem disabled={updates.checking} onClick={() => { close(); void updates.check(); }}>检查软件更新</MenuItem> : null}
        <MenuItem onClick={handleLogout}>
          <ListItemIcon><LogoutRounded fontSize="small" /></ListItemIcon>
          退出登录
        </MenuItem>
      </Menu>
      <DesktopUiUpdateDialog state={updates} />
    </>
  );
}
