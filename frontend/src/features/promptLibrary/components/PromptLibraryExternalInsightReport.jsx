import AssessmentRounded from '@mui/icons-material/AssessmentRounded';
import BarChartRounded from '@mui/icons-material/BarChartRounded';
import FactCheckRounded from '@mui/icons-material/FactCheckRounded';
import InsightsRounded from '@mui/icons-material/InsightsRounded';
import StorefrontRounded from '@mui/icons-material/StorefrontRounded';
import TaskAltRounded from '@mui/icons-material/TaskAltRounded';
import TrackChangesRounded from '@mui/icons-material/TrackChangesRounded';
import TrendingUpRounded from '@mui/icons-material/TrendingUpRounded';
import WarningAmberRounded from '@mui/icons-material/WarningAmberRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import React from 'react';
import { normalizeExternalOzonReportPresentation } from '../lib/smartToolExternalOzonInsightConfig.js';
import { sanitizeExternalOzonReportText } from '../lib/smartToolExternalOzonReportText.js';

const LOGO_ICONS = Object.freeze({
  insights: InsightsRounded,
  chart: BarChartRounded,
  target: TrackChangesRounded,
  store: StorefrontRounded,
});

const SECTION_ICONS = Object.freeze({
  assessment: AssessmentRounded,
  finding: FactCheckRounded,
  opportunity: TrendingUpRounded,
  risk: WarningAmberRounded,
  action: TaskAltRounded,
});

const OPERATIONS_BRIEF_EMOJIS = Object.freeze({
  logo: '📋',
  marketAssessment: '🧭',
  keyFindings: '🔎',
  opportunities: '🌱',
  risks: '⚠️',
  actionPlan: '✅',
});

function text(value) {
  return sanitizeExternalOzonReportText(value);
}

function ReportSectionHeading({ title, icon, showIcon, sectionId, visualStyle }) {
  const useEmoji = visualStyle === 'operations-brief' && showIcon;
  const Icon = !useEmoji && showIcon && icon !== 'none' ? SECTION_ICONS[icon] : null;
  return (
    <Box className="prompt-library-external-insight-section-heading">
      {useEmoji ? (
        <Box component="span" className="prompt-library-external-insight-section-emoji" aria-hidden="true">
          {OPERATIONS_BRIEF_EMOJIS[sectionId] || '•'}
        </Box>
      ) : null}
      {Icon ? (
        <Box component="span" className="prompt-library-external-insight-section-icon" aria-hidden="true">
          <Icon fontSize="small" />
        </Box>
      ) : null}
      <Typography component="h2">{title}</Typography>
    </Box>
  );
}

function ReportList({ section, items = [], presentation, visualStyle }) {
  if (!Array.isArray(items) || !items.length) return null;
  return (
    <Box
      component="section"
      className="prompt-library-external-insight-section"
      data-report-section={section.id}
    >
      <ReportSectionHeading
        title={section.title}
        icon={section.icon}
        showIcon={presentation.showSectionIcons}
        sectionId={section.id}
        visualStyle={visualStyle}
      />
      <Box component="ul" className="prompt-library-external-insight-list">
        {items.map((item, index) => (
          <Box component="li" className="prompt-library-external-insight-item" key={`${item?.title || section.title}-${index}`}>
            <Typography component="h3">
              {text(item?.title) || `${section.title} ${index + 1}`}
              {presentation.showPriority && item?.priority ? (
                <Typography component="span" className="prompt-library-external-insight-priority">
                  {text(item.priority)}
                </Typography>
              ) : null}
            </Typography>
            {item?.evidence ? (
              <Typography component="p" className="prompt-library-external-insight-detail">
                {presentation.showEvidenceLabels ? (
                  <Typography component="strong">数据依据：</Typography>
                ) : null}
                {text(item.evidence)}
              </Typography>
            ) : null}
            {item?.action ? (
              <Typography component="p" className="prompt-library-external-insight-detail prompt-library-external-insight-action">
                {presentation.showActionLabels ? (
                  <Typography component="strong">建议动作：</Typography>
                ) : null}
                {text(item.action)}
              </Typography>
            ) : null}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function MarketAssessment({ section, value, presentation, visualStyle }) {
  if (!value) return null;
  return (
    <Box
      component="section"
      className="prompt-library-external-insight-section"
      data-report-section={section.id}
    >
      <ReportSectionHeading
        title={section.title}
        icon={section.icon}
        showIcon={presentation.showSectionIcons}
        sectionId={section.id}
        visualStyle={visualStyle}
      />
      <Typography component="p" className="prompt-library-external-insight-prose">
        {text(value)}
      </Typography>
    </Box>
  );
}

function ReportSection({ section, report, presentation, visualStyle }) {
  if (!section.visible) return null;
  if (section.id === 'marketAssessment') {
    return (
      <MarketAssessment
        section={section}
        value={report.marketAssessment}
        presentation={presentation}
        visualStyle={visualStyle}
      />
    );
  }
  return (
    <ReportList
      section={section}
      items={report[section.id]}
      presentation={presentation}
      visualStyle={visualStyle}
    />
  );
}

export function PromptLibraryExternalInsightReport({
  insight = null,
  presentation: presentationValue = null,
  visualStyle = 'default',
}) {
  if (insight?.status === 'loading') {
    return (
      <Box className="prompt-library-external-insight-loading">
        <CircularProgress size={28} />
        <Typography variant="subtitle2">正在整理数据分析报告</Typography>
        <Typography variant="body2">正在根据本次查询结果整理重点、风险和可执行建议。</Typography>
      </Box>
    );
  }
  if (insight?.status === 'error') {
    return (
      <Alert severity="warning">
        <Typography variant="subtitle2">分析报告生成失败</Typography>
        <Typography variant="body2">{insight.message || '请重试。'}</Typography>
      </Alert>
    );
  }
  const report = insight?.report;
  if (!report) {
    return <Alert severity="info">先完成数据查询，再点击“数据分析”。</Alert>;
  }
  const presentation = normalizeExternalOzonReportPresentation(presentationValue);
  const useOperationsBrief = visualStyle === 'operations-brief';
  const LogoIcon = !useOperationsBrief && presentation.logo !== 'none'
    ? LOGO_ICONS[presentation.logo]
    : null;
  const showEmojiLogo = useOperationsBrief && presentation.logo !== 'none';
  const meta = [
    presentation.showModel && insight.model ? `模型 ${insight.model}` : '',
    presentation.showGeneratedAt && insight.generatedAt
      ? new Date(insight.generatedAt).toLocaleString('zh-CN')
      : '',
  ].filter(Boolean);
  return (
    <Box
      component="article"
      className="prompt-library-external-insight-report"
      data-accent={presentation.accent}
      data-density={presentation.density}
      data-visual-style={visualStyle}
    >
      <Box component="header" className="prompt-library-external-insight-summary">
        <Box className="prompt-library-external-insight-title-row">
          {LogoIcon ? (
            <Box className="prompt-library-external-insight-logo" aria-hidden="true">
              <LogoIcon />
            </Box>
          ) : null}
          {showEmojiLogo ? (
            <Box component="span" className="prompt-library-external-insight-emoji-logo" aria-hidden="true">
              {OPERATIONS_BRIEF_EMOJIS.logo}
            </Box>
          ) : null}
          <Box className="prompt-library-external-insight-title-copy">
            {presentation.eyebrow ? (
              <Typography component="p" className="prompt-library-external-insight-eyebrow">
                {text(presentation.eyebrow)}
              </Typography>
            ) : null}
            <Typography component="h1">{text(report.title) || '数据分析报告'}</Typography>
            {meta.length ? (
              <Typography className="prompt-library-external-insight-meta" variant="caption">
                {meta.join(' · ')}
              </Typography>
            ) : null}
          </Box>
        </Box>
        <Box className="prompt-library-external-insight-conclusion">
          <Typography component="span">{useOperationsBrief ? '🎯 核心结论' : '先看结论'}</Typography>
          <Typography component="p" className="prompt-library-external-insight-lead">
            {text(report.executiveSummary) || '暂无分析总结。'}
          </Typography>
        </Box>
      </Box>
      <Box className="prompt-library-external-insight-body">
        {presentation.sections.map((section) => (
          <ReportSection
            key={section.id}
            section={section}
            report={report}
            presentation={presentation}
            visualStyle={visualStyle}
          />
        ))}
      </Box>
    </Box>
  );
}
