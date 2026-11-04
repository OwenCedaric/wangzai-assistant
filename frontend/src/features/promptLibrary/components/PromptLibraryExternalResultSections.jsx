import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import React from 'react';

const RESULT_PAGE_SIZE = 100;

function ExternalResultSection({ section, sectionIndex }) {
  const rows = React.useMemo(
    () => (Array.isArray(section?.rows) ? section.rows : []),
    [section?.rows],
  );
  const totalPages = Math.max(1, Math.ceil(rows.length / RESULT_PAGE_SIZE));
  const [page, setPage] = React.useState(1);

  React.useEffect(() => {
    setPage(1);
  }, [rows]);

  const safePage = Math.min(page, totalPages);
  const startIndex = (safePage - 1) * RESULT_PAGE_SIZE;
  const visibleRows = rows.slice(startIndex, startIndex + RESULT_PAGE_SIZE);

  return (
    <Box className="prompt-library-external-result-section">
      <Stack
        className="prompt-library-external-result-section-head"
        direction="row"
        alignItems="center"
        justifyContent="space-between"
      >
        <Typography variant="subtitle2">{section?.title || '结果'}</Typography>
        {rows.length > RESULT_PAGE_SIZE ? (
          <Typography variant="caption">
            {startIndex + 1}-{Math.min(startIndex + RESULT_PAGE_SIZE, rows.length)} / {rows.length}
          </Typography>
        ) : null}
      </Stack>
      <Stack className="prompt-library-external-result-rows" spacing={0.65}>
        {visibleRows.map((row, rowIndex) => (
          <Typography
            key={`${sectionIndex}-${startIndex + rowIndex}`}
            variant="body2"
            color="text.secondary"
          >
            {String(row || '')}
          </Typography>
        ))}
      </Stack>
      {totalPages > 1 ? (
        <Stack className="prompt-library-external-result-pagination" direction="row" alignItems="center">
          <Button
            size="small"
            variant="text"
            disabled={safePage <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            上一页
          </Button>
          <Typography variant="caption">第 {safePage} / {totalPages} 页</Typography>
          <Button
            size="small"
            variant="text"
            disabled={safePage >= totalPages}
            onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
          >
            下一页
          </Button>
        </Stack>
      ) : null}
    </Box>
  );
}

export function PromptLibraryExternalResultSections({ sections = [] }) {
  return (Array.isArray(sections) ? sections : []).map((section, sectionIndex) => (
    <ExternalResultSection
      key={`${section?.title || 'section'}-${sectionIndex}`}
      section={section}
      sectionIndex={sectionIndex}
    />
  ));
}
