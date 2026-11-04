import Box from '@mui/material/Box';
import React from 'react';
import { PointsPackageBillingPanel } from './components/PointsPackageBillingPanel.jsx';
import { PointsPackageFaqPanel } from './components/PointsPackageFaqPanel.jsx';
import { PointsPackageHeader } from './components/PointsPackageHeader.jsx';
import { PointsPackagePaymentDialog } from './components/PointsPackagePaymentDialog.jsx';
import { PointsPackageModelPresetDialog } from './components/PointsPackageModelPresetDialog.jsx';
import { PointsPackagePlansPanel } from './components/PointsPackagePlansPanel.jsx';
import { usePointsPackagesModel } from './model/usePointsPackagesModel.jsx';

export function PointsPackagesPage() {
  const model = usePointsPackagesModel();

  return (
    <Box
      sx={{
        minHeight: '100%',
        width: '100%',
        px: { xs: 1.5, md: 2, xl: 2.5 },
        py: { xs: 1.25, md: 1.75 },
        bgcolor: 'transparent',
      }}
    >
      <PointsPackageHeader
        activeTab={model.activeTab}
        onTabChange={model.setActiveTab}
        wallet={model.wallet}
        loading={model.loading}
        onRefresh={model.refreshAccount}
        onOpenModelPreset={model.openModelPreset}
        enabledModelCount={model.enabledModelCount}
      />
      <Box sx={{ width: '100%', mx: 'auto', py: { xs: 1.25, md: 1.75 } }}>
        {model.activeTab === 'plans' ? <PointsPackagePlansPanel model={model} /> : null}
        {model.activeTab === 'billing' ? (
          <PointsPackageBillingPanel ledger={model.ledger} wallet={model.wallet} />
        ) : null}
        {model.activeTab === 'faq' ? (
          <PointsPackageFaqPanel expandedIndex={model.expandedFaqIndex} onToggle={model.toggleFaq} />
        ) : null}
      </Box>
      <PointsPackagePaymentDialog model={model} />
      <PointsPackageModelPresetDialog model={model} />
    </Box>
  );
}
