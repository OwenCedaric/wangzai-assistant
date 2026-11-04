import React from 'react';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { PROFIT_MANUAL_OVERRIDE_FIELDS } from '../../../entities/profit/profitFinanceEvidence.jsx';

export function ProfitEditableMoney({ fieldId, value, className, hint = '', editor, orderKey, setEditor, editing }) {
  const editable = Boolean(PROFIT_MANUAL_OVERRIDE_FIELDS[fieldId]);
  const isEditing = editable && editor?.fieldId === fieldId && editor?.orderKey === orderKey;
  if (isEditing) return (
    <TextField
      size="small" className="profit-inline-money-input" autoFocus value={editor.value}
      disabled={editor.saving === true} error={Boolean(editor.error)} helperText={editor.saving ? '保存中…' : editor.error}
      onChange={event => setEditor(current => current ? { ...current, value: event.target.value, error: '' } : current)}
      onBlur={() => { if (!editor.error && !editor.saving) void editing.save(); }}
      onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); void editing.save(); }
        if (event.key === 'Escape') { event.preventDefault(); editing.cancel(); }
      }}
      inputProps={{ inputMode: 'decimal', 'aria-label': '编辑利润金额' }}
    />
  );
  return (
    <Typography variant="body2" className={`${className}${editable ? ' profit-inline-editable-value' : ''}`}
      title={editable ? (hint ? `${hint}；双击修改` : '双击修改') : hint || undefined}
      onDoubleClick={editable ? () => editing.begin(fieldId) : undefined}>
      {value}
    </Typography>
  );
}
