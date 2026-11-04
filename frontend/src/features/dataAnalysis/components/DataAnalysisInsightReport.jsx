import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Collapse from '@mui/material/Collapse';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { DATA_ANALYSIS_INSIGHT_FREEZE_VERSION } from '../constants/dataAnalysisInsightFreezeContract.js';
import { formatDataAnalysisMetric, formatDataAnalysisTime } from '../lib/dataAnalysisFormatter.js';
import {
  getDataAnalysisSectionEmoji,
  isWideDataAnalysisReportSection,
  parseDataAnalysisInsightSections,
  parseDataAnalysisReportBody,
  selectDataAnalysisReportMetrics,
} from '../lib/dataAnalysisInsightReport.js';

function DataAnalysisReportBody({ body = '' }) {
  const blocks = parseDataAnalysisReportBody(body);
  return (
    <Box className="data-analysis-report-body">
      {blocks.map((block, index) => block.type === 'list' ? (
        <Box component="ul" className="data-analysis-report-list" key={`list-${index}`}>
          {block.items.map((item, itemIndex) => (
            <Box component="li" key={`${item}-${itemIndex}`}>{item}</Box>
          ))}
        </Box>
      ) : block.type === 'label' ? (
        <Box className="data-analysis-report-labeled-line" key={`${block.label}-${index}`}>
          <Typography component="strong">{block.label}</Typography>
          <Typography component="span">{block.text}</Typography>
        </Box>
      ) : (
        <Typography component="p" key={`paragraph-${index}`}>{block.text}</Typography>
      ))}
    </Box>
  );
}

function SectionAdjustment({
  open = false,
  loading = false,
  adjustmentText = '',
  modelReady = false,
  placeholder = '',
  onTextChange,
  onAnalyze,
}) {
  return (
    <Collapse in={open} unmountOnExit>
      <Stack spacing={0.8} className="data-analysis-report-adjustment">
        <TextField
          size="small"
          fullWidth
          value={adjustmentText}
          onChange={(event) => onTextChange(event.target.value)}
          placeholder={placeholder}
          label="补充本节分析要求"
        />
        <Button
          size="small"
          variant="contained"
          sx={{ alignSelf: 'flex-start' }}
          disabled={loading || !adjustmentText.trim() || !modelReady}
          onClick={onAnalyze}
        >
          按此要求重新分析
        </Button>
      </Stack>
    </Collapse>
  );
}

export function DataAnalysisInsightReport({
  dashboard = {},
  filters = {},
  state = {},
  modelLabel = '文本模型',
  loading = false,
  modelReady = false,
  onAnalyze,
}) {
  const [collapsedSections, setCollapsedSections] = React.useState(() => new Set());
  const [adjustmentSectionIndex, setAdjustmentSectionIndex] = React.useState(null);
  const [adjustmentText, setAdjustmentText] = React.useState('');
  const sections = parseDataAnalysisInsightSections(state.insight);
  const metrics = selectDataAnalysisReportMetrics(dashboard);
  const summarySection = sections[0] || null;
  const detailSections = sections.slice(1);

  React.useEffect(() => {
    setCollapsedSections(new Set());
    setAdjustmentSectionIndex(null);
    setAdjustmentText('');
  }, [state.insight]);

  const toggleSection = (index) => {
    setCollapsedSections((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const openSectionAdjustment = (index) => {
    setAdjustmentSectionIndex((current) => (current === index ? null : index));
    setAdjustmentText('');
  };

  const analyzeSection = (section) => {
    onAnalyze({
      userPromptOverride: `请重点重新分析“${section.title}”这一部分。${adjustmentText.trim()}`,
    });
  };

  return (
    <Box
      component="article"
      className="data-analysis-report-sheet"
      data-freeze-version={DATA_ANALYSIS_INSIGHT_FREEZE_VERSION}
    >
      <Box component="header" className="data-analysis-report-cover">
        <Box className="data-analysis-report-cover-main">
          <Typography className="data-analysis-report-kicker">店铺经营复盘</Typography>
          <Typography component="h2" className="data-analysis-report-title">经营结论与行动报告</Typography>
          <Typography className="data-analysis-report-subtitle">
            汇总销售、商品、库存、费用、售后与营销表现，给出可直接执行的处理顺序。
          </Typography>
        </Box>
        <Box className="data-analysis-report-meta-grid">
          <Box><Typography component="span">分析店铺</Typography><Typography component="strong">{filters.shopId || '全部店铺'}</Typography></Box>
          <Box><Typography component="span">统计周期</Typography><Typography component="strong">{filters.startDate || '未指定'} 至 {filters.endDate || '未指定'}</Typography></Box>
          <Box><Typography component="span">生成时间</Typography><Typography component="strong">{formatDataAnalysisTime(dashboard.generatedAt, '刚刚生成')}</Typography></Box>
          <Box><Typography component="span">分析状态</Typography><Typography component="strong">报告已完成</Typography></Box>
        </Box>
      </Box>

      {metrics.length ? (
        <Box component="section" aria-label="报告核心经营指标" className="data-analysis-report-metrics">
          {metrics.map((metric) => (
            <Box key={metric.id} className="data-analysis-report-metric">
              <Typography component="span">{metric.label}</Typography>
              <Typography component="strong">{formatDataAnalysisMetric(metric)}</Typography>
            </Box>
          ))}
        </Box>
      ) : null}

      {summarySection ? (
        <Box component="section" className="data-analysis-report-summary">
          <Box className="data-analysis-report-summary-heading">
            <Typography component="span" aria-hidden="true">{getDataAnalysisSectionEmoji(summarySection.title)}</Typography>
            <Box>
              <Typography component="span">先看结论</Typography>
              <Typography component="h3">{summarySection.title}</Typography>
            </Box>
          </Box>
          <Box minWidth={0}>
            <DataAnalysisReportBody body={summarySection.body} />
            <Button
              size="small"
              variant="text"
              className="data-analysis-report-adjust-button"
              onClick={() => openSectionAdjustment(0)}
            >
              {adjustmentSectionIndex === 0 ? '收起调整' : '调整本节'}
            </Button>
            <SectionAdjustment
              open={adjustmentSectionIndex === 0}
              loading={loading}
              adjustmentText={adjustmentText}
              modelReady={modelReady}
              placeholder="例如：将总体判断改成更直接的处理结论"
              onTextChange={setAdjustmentText}
              onAnalyze={() => analyzeSection(summarySection)}
            />
          </Box>
        </Box>
      ) : null}

      {detailSections.length ? (
        <Box component="nav" aria-label="报告目录" className="data-analysis-report-directory">
          <Typography component="strong">报告目录</Typography>
          <Box>
            {detailSections.map((section, index) => (
              <Typography component="span" key={`${section.title}-directory`}>
                {String(index + 2).padStart(2, '0')} {section.title}
              </Typography>
            ))}
          </Box>
        </Box>
      ) : null}

      <Box className="data-analysis-report-section-grid">
        {detailSections.map((section, detailIndex) => {
          const index = detailIndex + 1;
          const expanded = !collapsedSections.has(index);
          const adjusting = adjustmentSectionIndex === index;
          const wide = isWideDataAnalysisReportSection({
            title: section.title,
            index: detailIndex,
            count: detailSections.length,
          });
          return (
            <Box
              component="section"
              key={`${section.title}-${index}`}
              className={`data-analysis-report-section${wide ? ' data-analysis-report-section-wide' : ''}`}
            >
              <Box
                component="button"
                type="button"
                onClick={() => toggleSection(index)}
                className="data-analysis-report-section-heading"
              >
                <Typography component="span" className="data-analysis-report-section-number">{String(index + 1).padStart(2, '0')}</Typography>
                <Typography component="span" className="data-analysis-report-section-emoji">{getDataAnalysisSectionEmoji(section.title)}</Typography>
                <Typography component="span" className="data-analysis-report-section-title">{section.title}</Typography>
                <Typography component="span" className="data-analysis-report-section-toggle">{expanded ? '收起' : '展开'}</Typography>
              </Box>
              <Collapse in={expanded} unmountOnExit>
                <Box className="data-analysis-report-section-content">
                  <DataAnalysisReportBody body={section.body} />
                  <Button
                    size="small"
                    variant="text"
                    className="data-analysis-report-adjust-button"
                    onClick={() => openSectionAdjustment(index)}
                  >
                    {adjusting ? '收起调整' : '调整本节'}
                  </Button>
                  <SectionAdjustment
                    open={adjusting}
                    loading={loading}
                    adjustmentText={adjustmentText}
                    modelReady={modelReady}
                    placeholder="例如：重点分析低销量商品的原因和处理顺序"
                    onTextChange={setAdjustmentText}
                    onAnalyze={() => analyzeSection(section)}
                  />
                </Box>
              </Collapse>
            </Box>
          );
        })}
      </Box>

      <Box component="footer" className="data-analysis-report-footer">
        <Typography component="span">分析模型：{modelLabel}</Typography>
        <Typography component="span">数据更新时间：{formatDataAnalysisTime(state.meta?.sourceUpdatedAt || dashboard.sourceUpdatedAt)}</Typography>
        <Typography component="span">报告结论仅基于当前统计周期内已读取的数据</Typography>
      </Box>
    </Box>
  );
}
