import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import {
  splitSmartToolUsageInputItems,
  validateSmartToolUsageInputItem,
} from '../lib/smartToolUsage.js';

function toRows(value) {
  const rows = String(value ?? '').replace(/\r/gu, '').split('\n');
  return rows.length ? rows : [''];
}

function toValue(rows) {
  return rows.join('\n');
}

export function PromptLibraryRepeatableInputList({
  tool,
  label,
  value = '',
  inputSpec = {},
  placeholder = '',
  helperText = '',
  error = false,
  onChange = () => {},
}) {
  const maxItems = Math.max(1, Number(inputSpec.maxItems) || 20);
  const rows = toRows(value).slice(0, maxItems);
  const filledCount = splitSmartToolUsageInputItems(value, inputSpec).length;

  const changeRow = React.useCallback((index, nextValue) => {
    const nextRows = [...rows];
    nextRows[index] = nextValue;
    onChange(toValue(nextRows));
  }, [onChange, rows]);

  const addRow = React.useCallback(() => {
    if (rows.length >= maxItems) return;
    onChange(toValue([...rows, '']));
  }, [maxItems, onChange, rows]);

  const removeRow = React.useCallback((index) => {
    if (rows.length === 1) {
      onChange('');
      return;
    }
    onChange(toValue(rows.filter((_, rowIndex) => rowIndex !== index)));
  }, [onChange, rows]);

  const pasteRows = React.useCallback((event, index) => {
    const pasted = event.clipboardData?.getData('text') || '';
    if (!/[\n\r,，;；]/u.test(pasted)) return;
    const pastedRows = splitSmartToolUsageInputItems(pasted, inputSpec);
    if (pastedRows.length < 2) return;
    event.preventDefault();
    const nextRows = [
      ...rows.slice(0, index),
      ...pastedRows,
      ...rows.slice(index + 1),
    ].slice(0, maxItems);
    onChange(toValue(nextRows));
  }, [inputSpec, maxItems, onChange, rows]);

  return (
    <Box className="prompt-library-repeatable-field">
      <Box className="prompt-library-repeatable-field-head">
        <Box className="prompt-library-repeatable-field-title">
          <Typography component="label" variant="caption">{label}</Typography>
          <Typography variant="caption">{filledCount}/{maxItems}</Typography>
        </Box>
      </Box>

      <Box className="prompt-library-repeatable-rows">
        {rows.map((row, index) => {
          const rowError = validateSmartToolUsageInputItem(tool, label, row);
          return (
            <Box className="prompt-library-repeatable-row" key={`${label}-${index}`}>
              <TextField
                className="prompt-library-repeatable-input"
                value={row}
                placeholder={index === 0 ? placeholder : `第 ${index + 1} 条`}
                error={Boolean(rowError)}
                helperText={rowError || undefined}
                inputProps={{ 'aria-label': index === 0 ? label : `${label} 第${index + 1}条` }}
                onChange={(event) => changeRow(index, event.target.value)}
                onPaste={(event) => pasteRows(event, index)}
                size="small"
                fullWidth
              />
              {index === 0 ? (
                <IconButton
                  className="prompt-library-repeatable-add"
                  aria-label={`增加${label}`}
                  title={`增加一条（最多 ${maxItems} 条）`}
                  disabled={rows.length >= maxItems}
                  onClick={addRow}
                  size="small"
                >
                  <span aria-hidden="true">+</span>
                </IconButton>
              ) : (
                <IconButton
                  className="prompt-library-repeatable-remove"
                  aria-label={`删除${label}第${index + 1}条`}
                  title="删除这一条"
                  onClick={() => removeRow(index)}
                  size="small"
                >
                  <span aria-hidden="true">−</span>
                </IconButton>
              )}
            </Box>
          );
        })}
      </Box>

      {helperText ? (
        <Typography
          className={`prompt-library-repeatable-helper${error ? ' is-error' : ''}`}
          variant="caption"
        >
          {helperText}
        </Typography>
      ) : null}
    </Box>
  );
}
