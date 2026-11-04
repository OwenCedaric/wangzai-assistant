import { createTheme } from '@mui/material/styles';

export const appTheme = createTheme({
  palette: {
    mode: 'light',
    primary: {
      main: '#5d87ff',
      light: '#ecf2ff',
      dark: '#3461d4',
    },
    secondary: {
      main: '#49beff',
      light: '#e8f7ff',
    },
    success: {
      main: '#13deb9',
      light: '#e6fffa',
    },
    warning: {
      main: '#ffae1f',
      light: '#fef5e5',
    },
    error: {
      main: '#fa896b',
      light: '#fdede8',
    },
    info: {
      main: '#539bff',
      light: '#ebf3fe',
    },
    background: {
      default: '#f5f7fb',
      paper: '#ffffff',
    },
    text: {
      primary: '#2a3547',
      secondary: '#5a6a85',
    },
    divider: '#eef1f6',
  },
  typography: {
    fontFamily:
      '"Inter", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", Arial, sans-serif',
    h4: {
      fontSize: 24,
      fontWeight: 700,
      letterSpacing: 0,
    },
    h5: {
      fontSize: 20,
      fontWeight: 700,
      letterSpacing: 0,
    },
    h6: {
      fontSize: 16,
      fontWeight: 700,
      letterSpacing: 0,
    },
    subtitle1: {
      fontSize: 14,
      fontWeight: 600,
      letterSpacing: 0,
    },
    body1: {
      fontSize: 14,
      letterSpacing: 0,
    },
    body2: {
      fontSize: 13,
      letterSpacing: 0,
    },
  },
  shape: {
    borderRadius: 8,
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          boxShadow: 'none',
          textTransform: 'none',
          fontWeight: 700,
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          boxShadow: '0 2px 14px rgba(38, 46, 67, 0.08)',
          border: '1px solid #eef1f6',
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          fontWeight: 700,
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
        },
      },
    },
  },
});
