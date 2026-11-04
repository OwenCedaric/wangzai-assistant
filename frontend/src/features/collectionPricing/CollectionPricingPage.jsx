import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';

import { useDesktopAuth } from '../licensing/model/DesktopAuthContext.jsx';
import { CollectionDraftCard } from './components/CollectionDraftCard.jsx';
import { CollectionPricingHeader } from './components/CollectionPricingHeader.jsx';
import { CollectionProductList } from './components/CollectionProductList.jsx';
import { useCollectionPricingDraft } from './model/useCollectionPricingDraft.js';

export function resolveCollectionPricingOwnerScopeKey(session = {}) {
  const userId = session?.user?.id ?? session?.user?.userId;
  return userId == null ? '' : String(userId).trim();
}

export function CollectionPricingPage({ shops = [], activeShopId = '', onActiveShopChange }) {
  const { session } = useDesktopAuth();
  const ownerScopeKey = resolveCollectionPricingOwnerScopeKey(session);
  const workflow = useCollectionPricingDraft({
    shops,
    activeShopId,
    onActiveShopChange,
    ownerScopeKey,
  });

  return (
    <Box className="collection-pricing-page" sx={{ width: '100%' }}>
      <CollectionPricingHeader
        collectionCount={workflow.collectionItems.length}
        onClear={workflow.clearDraft}
      />

      {workflow.copyMessage ? <Alert severity="success" sx={{ mb: 1.5 }}>{workflow.copyMessage}</Alert> : null}
      {workflow.collectionPersistenceError ? (
        <Alert severity="error" sx={{ mb: 1.5 }}>{workflow.collectionPersistenceError}</Alert>
      ) : null}
      <Stack spacing={1.25}>
        <CollectionDraftCard
          collectionMode={workflow.collectionMode}
          collectorDraft={workflow.collectorDraft}
          browserState={workflow.browserState}
          onChangeMode={workflow.setCollectionMode}
          onChangeField={workflow.updateCollectorDraft}
          onOpenBrowser={workflow.openCollectionBrowser}
          onCaptureCurrent={workflow.captureCollectionProduct}
          onCollectLink={workflow.collectProductLink}
        />
        <CollectionProductList
          items={workflow.collectionItems}
          shops={shops}
          activeShopId={activeShopId}
          selectedId={workflow.selectedCollectionId}
          onSelect={workflow.selectCollectionItem}
          onOpenSource={workflow.openCollectionItemSource}
          onEdit={workflow.editCollectionItem}
          onDelete={workflow.removeCollectionItem}
        />
      </Stack>
    </Box>
  );
}
