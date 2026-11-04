import SearchRounded from '@mui/icons-material/SearchRounded';
import Box from '@mui/material/Box';
import InputAdornment from '@mui/material/InputAdornment';
import TextField from '@mui/material/TextField';

function OrderSideSearch({ value, onChange, placeholder = '搜索单号 / 货号 / 商品', className = '' }) {
  const extraClassName = className ? ` ${className}` : '';

  return (
    <Box className={`marketing-side-search purchase-order-side-search is-visible${extraClassName}`} aria-hidden={false}>
      <TextField
        className="marketing-side-search-field"
        size="small"
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        InputProps={{
          startAdornment: (
            <InputAdornment position="start">
              <SearchRounded />
            </InputAdornment>
          ),
        }}
      />
    </Box>
  );
}

export { OrderSideSearch };
