import {
  buildProductAttributeEditRows,
  getAttributeList,
  isOzonAttributeDictionary,
} from '../../../entities/product/productAttributes.jsx';
import {
  buildOzonEditableAttributes,
  createProductEditForm,
  createProductImageSlots,
  getAttributeFormValues,
  getChangedAttributeRows,
  getMovedActiveIndex,
  hasDetailImagesChanged,
  MIN_PRODUCT_IMAGE_SLOTS,
  normalizeImageList,
  readImageFilesAsDataUrls,
  reorderItems,
} from '../../../entities/product/productWriteHelpers.jsx';
import { buildProductCardDiff } from '../../../services/productCardDiff';
import {
  preloadProductAttributeOptions,
  readProductAttributeOptions,
  readProductEditorContext,
} from '../../../services/productModuleClient.js';
import {
  applyProductMaterialProfile,
  canEditProductMaterialFields,
  editableProductMaterialSourceOptions,
  getProductMaterialSource,
  PRODUCT_MATERIAL_SOURCE_CROSS_BORDER,
  productMaterialSourceMeta,
} from '../../../services/productMaterialProfileStore';
import { getProductImageGroupLabel, ProductReadOnlyField } from '../lib/productEditing.jsx';
import { ProductAttributeEditor } from './ProductAttributeEditor.jsx';
import { ProductSaveConfirmDialog } from './ProductSaveConfirmDialog.jsx';
import AddRounded from '@mui/icons-material/AddRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '../../../shared/ui/minimizedTasks/GlobalMinimizableDialog.jsx';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';

export function ProductEditDialog({ open, product, shop, saving, onClose, onSave, onReadBus }) {
  const displayProduct = React.useMemo(() => applyProductMaterialProfile(product, shop), [product, shop]);
  const [form, setForm] = React.useState(() => createProductEditForm(displayProduct));
  const [activeImageIndex, setActiveImageIndex] = React.useState(0);
  const [attributeDefinitions, setAttributeDefinitions] = React.useState([]);
  const [attributeOptionsById, setAttributeOptionsById] = React.useState({});
  const [attributeOptionsLoading, setAttributeOptionsLoading] = React.useState({});
  const [liveAttributePayload, setLiveAttributePayload] = React.useState(null);
  const [attributeContextMeta, setAttributeContextMeta] = React.useState({});
  const [attributeLoading, setAttributeLoading] = React.useState(false);
  const [dragImage, setDragImage] = React.useState(null);
  const [saveConfirmOpen, setSaveConfirmOpen] = React.useState(false);
  const mainImageInputRef = React.useRef(null);
  const detailImageInputRef = React.useRef(null);

  React.useEffect(() => {
    setForm(createProductEditForm(displayProduct));
    setActiveImageIndex(0);
    setDragImage(null);
    setSaveConfirmOpen(false);
  }, [displayProduct]);

  React.useEffect(() => {
    setActiveImageIndex((current) => {
      if (!form.images.length) return 0;
      return Math.min(current, form.images.length - 1);
    });
  }, [form.images.length]);

  React.useEffect(() => {
    setAttributeDefinitions([]);
    setAttributeOptionsById({});
    setAttributeOptionsLoading({});
    setLiveAttributePayload(null);
    setAttributeContextMeta({});
    setAttributeLoading(false);
    if (!open || !shop?.id || !displayProduct) {
      return undefined;
    }

    let active = true;
    setAttributeLoading(true);
    readProductEditorContext({
      shopId: shop.id,
      productId: displayProduct.productId,
      offerId: displayProduct.offerId,
      descriptionCategoryId: displayProduct.descriptionCategoryId,
      typeId: displayProduct.typeId,
    })
      .then((context) => {
        if (!active) return;
        setAttributeDefinitions(context.attributeDefinitions || []);
        const scopedAttributeDefinitions = context.attributeDefinitions || [];
        const dictionaryIds = scopedAttributeDefinitions
          .filter(isOzonAttributeDictionary)
          .map((definition) => String(definition.id ?? definition.attributeId ?? definition.attribute_id ?? '').trim())
          .filter(Boolean);
        setAttributeOptionsLoading(Object.fromEntries([...new Set(dictionaryIds)].map((id) => [id, true])));
        setLiveAttributePayload({ attributes: context.attributes || [] });
        setAttributeContextMeta({
          scope: context.attributeScope || {},
          source: context.attributeDefinitionSource || '',
          warning: context.attributeDefinitionWarning || '',
        });
        void preloadProductAttributeOptions({
          shopId: shop.id,
          categoryId: displayProduct.descriptionCategoryId,
          typeId: displayProduct.typeId,
        }, scopedAttributeDefinitions, { concurrency: 4 })
          .then((optionsById) => {
            if (!active) return;
            setAttributeOptionsById(optionsById);
          })
          .catch(() => undefined)
          .finally(() => {
            if (!active) return;
            setAttributeOptionsLoading((current) => Object.fromEntries(
              Object.keys(current).map((id) => [id, false]),
            ));
          });
      })
      .catch((error) => {
        if (!active) return;
        setAttributeDefinitions([]);
        setLiveAttributePayload(null);
        setAttributeContextMeta({
          warning: error instanceof Error ? error.message : String(error || '当前商品属性读取失败'),
        });
      })
      .finally(() => {
        if (active) setAttributeLoading(false);
      });

    return () => {
      active = false;
    };
  }, [
    displayProduct,
    displayProduct?.descriptionCategoryId,
    displayProduct?.offerId,
    displayProduct?.productId,
    displayProduct?.typeId,
    open,
    shop?.id,
  ]);

  const loadAttributeOptions = React.useCallback(async (item, searchText = '') => {
    const attributeId = String(item?.attributeId || item?.id || '').trim();
    const normalizedSearchText = String(searchText || '').trim();
    if (
      !attributeId
      || !displayProduct
      || !open
      || attributeOptionsLoading[attributeId]
      || (!normalizedSearchText && Object.prototype.hasOwnProperty.call(attributeOptionsById, attributeId)
        && attributeOptionsById[attributeId].length > 0)
    ) return;
    setAttributeOptionsLoading((current) => ({ ...current, [attributeId]: true }));
    try {
      const options = await readProductAttributeOptions({
        shopId: shop?.id,
        categoryId: displayProduct.descriptionCategoryId,
        typeId: displayProduct.typeId,
        attributeId,
        search: normalizedSearchText,
      });
      setAttributeOptionsById((current) => {
        const merged = [...(current[attributeId] || []), ...options];
        const seen = new Set();
        return {
          ...current,
          [attributeId]: merged.filter((option) => {
            const key = `${String(option?.id ?? '').trim()}:${String(option?.value ?? option?.label ?? '').trim()}`;
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
          }),
        };
      });
    } catch {
      setAttributeOptionsById((current) => ({
        ...current,
        [attributeId]: current[attributeId] || [],
      }));
    } finally {
      setAttributeOptionsLoading((current) => ({ ...current, [attributeId]: false }));
    }
  }, [attributeOptionsById, attributeOptionsLoading, displayProduct, open, shop?.id]);

  const attributeProduct = React.useMemo(() => {
    if (!displayProduct) return null;
    if (!liveAttributePayload) return displayProduct;
    return {
      ...displayProduct,
      attributes: getAttributeList(liveAttributePayload),
      raw: { ...displayProduct.raw, attributes: liveAttributePayload },
    };
  }, [displayProduct, liveAttributePayload]);

  const attributeRows = React.useMemo(
    () => buildProductAttributeEditRows(attributeProduct, attributeDefinitions),
    [attributeProduct, attributeDefinitions]
  );

  const attributeRowsKey = React.useMemo(
    () => attributeRows.map((row) => `${row.id}:${row.label}:${row.value}:${row.required ? '1' : '0'}`).join('|'),
    [attributeRows]
  );

  React.useEffect(() => {
    if (!open || !displayProduct || attributeRows.length === 0) return;
    setForm((current) => {
      if (current.attributeSourceKey === attributeRowsKey) return current;
      const attributeValues = getAttributeFormValues(attributeRows);
      return {
        ...current,
        attributeValues,
        attributeDictionaryValueIds: {},
        attributeRows,
        attributes: buildOzonEditableAttributes(attributeRows, attributeValues, {}),
        attributeSourceKey: attributeRowsKey,
      };
    });
  }, [attributeRows, attributeRowsKey, displayProduct, open]);

  if (!product) return null;

  const materialSource = form.materialSource || getProductMaterialSource(displayProduct);
  const materialFieldsEditable = canEditProductMaterialFields(materialSource);
  const materialSourceOptions =
    materialSource === PRODUCT_MATERIAL_SOURCE_CROSS_BORDER
      ? [PRODUCT_MATERIAL_SOURCE_CROSS_BORDER]
      : editableProductMaterialSourceOptions;

  const updateField = (field) => (event) => {
    setForm((current) => ({ ...current, [field]: event.target.value }));
  };

  const updateAttributeField = (id) => (event) => {
    const value = event.target.value;
    const hasDictionaryValueIds = Object.prototype.hasOwnProperty.call(event.target, 'dictionaryValueIds');
    const nextDictionaryValueIds = Array.isArray(event.target.dictionaryValueIds)
      ? event.target.dictionaryValueIds
      : [];
    setForm((current) => {
      const attributeValues = { ...current.attributeValues, [id]: value };
      const attributeDictionaryValueIds = { ...(current.attributeDictionaryValueIds || {}) };
      if (hasDictionaryValueIds) attributeDictionaryValueIds[id] = nextDictionaryValueIds;
      return {
        ...current,
        attributeValues,
        attributeDictionaryValueIds,
        attributeRows,
        attributes: buildOzonEditableAttributes(attributeRows, attributeValues, attributeDictionaryValueIds),
      };
    });
  };

  const removeImage = (index) => {
    setForm((current) => ({
      ...current,
      images: current.images.filter((_, imageIndex) => imageIndex !== index),
    }));
  };

  const removeDetailImage = (index) => {
    setForm((current) => ({
      ...current,
      detailImages: normalizeImageList(current.detailImages).filter((_, imageIndex) => imageIndex !== index),
    }));
  };

  const reorderImages = (field, fromIndex, toIndex) => {
    setForm((current) => {
      const images = normalizeImageList(current[field]);
      return { ...current, [field]: reorderItems(images, fromIndex, toIndex) };
    });
    if (field === 'images') {
      setActiveImageIndex((current) => getMovedActiveIndex(current, fromIndex, toIndex));
    }
  };

  const startImageDrag = (field, index) => (event) => {
    if (saving) return;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', `${field}:${index}`);
    setDragImage({ field, index });
  };

  const allowImageDrop = (field, index) => (event) => {
    const source = dragImage;
    if (source?.field === field && source.index !== index) {
      event.preventDefault();
    }
  };

  const dropImage = (field, index) => (event) => {
    event.preventDefault();
    const transferValue = event.dataTransfer.getData('text/plain');
    const [transferField, transferIndex] = transferValue.split(':');
    const source = dragImage?.field ? dragImage : { field: transferField, index: Number(transferIndex) };
    if (source.field === field && Number.isInteger(source.index) && source.index !== index) {
      reorderImages(field, source.index, index);
    }
    setDragImage(null);
  };

  const uploadImages = (field) => async (event) => {
    const files = event.target.files;
    try {
      const urls = await readImageFilesAsDataUrls(files);
      if (urls.length > 0) {
        setForm((current) => ({
          ...current,
          [field]: [...normalizeImageList(current[field]), ...urls],
        }));
      }
    } catch {
      window.alert('图片读取失败，请重新选择图片。');
    } finally {
      event.target.value = '';
    }
  };

  const mainImages = normalizeImageList(form.images);
  const detailImages = normalizeImageList(form.detailImages);
  const mainImageSlots = createProductImageSlots(mainImages);
  const detailImageSlots = createProductImageSlots(detailImages);
  const mainImageLabel = getProductImageGroupLabel('主图/轮播图', mainImages.length);
  const detailImageLabel = getProductImageGroupLabel('详情图', detailImages.length);
  const changedAttributeRows = getChangedAttributeRows(attributeRows, form.attributeValues);
  const productCardDiff = buildProductCardDiff(product, { ...form, attributeRows });
  const saveChangeItems = [
    ...productCardDiff.summaryLabels,
    hasDetailImagesChanged(product, form) ? '详情图' : '',
  ].filter(Boolean);

  const submitSave = () => {
    const attributeValues = form.attributeValues || {};
    const attributeDictionaryValueIds = form.attributeDictionaryValueIds || {};
    setSaveConfirmOpen(false);
    onSave(
      {
        ...form,
        attributeValues,
        attributeDictionaryValueIds,
        attributeRows,
        attributes: buildOzonEditableAttributes(attributeRows, attributeValues, attributeDictionaryValueIds),
      },
      {
      humanConfirmed: true,
        realWrite: true,
        dryRun: false,
      waitForResult: true,
      }
    );
  };

  return (
    <>
      <Dialog
        open={open}
        onClose={saving ? undefined : onClose}
        fullWidth
        maxWidth="xl"
        scroll="paper"
        className="product-editor-modal"
      >
        <DialogTitle component="div" className="product-editor-title">
          <Typography variant="h4" component="div">
            编辑在线商品
          </Typography>
          <IconButton aria-label="关闭" onClick={onClose} disabled={saving}>
            ×
          </IconButton>
        </DialogTitle>
        <DialogContent dividers className="product-editor-content">
          <Box className="product-editor-layout">
            <Box className="product-editor-left">
              <Box className="product-editor-section product-editor-basic-section">
                <Stack direction="row" alignItems="center" spacing={1} mb={1.5} className="product-editor-basic-header">
                  <Typography variant="h6">商品基础信息</Typography>
                  <Chip size="small" color="primary" label="Ozon 自动回填字段不可修改" />
                </Stack>
                <Box className="product-editor-grid product-editor-basic-grid">
                  <TextField
                    size="small"
                    className="editor-field-6"
                    label="商品名称"
                    value={form.name}
                    onChange={updateField('name')}
                  />
                  <ProductReadOnlyField
                    className="editor-field-3"
                    label="货号 Offer ID"
                    value={product.offerId || '-'}
                  />
                  <ProductReadOnlyField
                    className="editor-field-3"
                    label="Ozon 商品 ID / SKU"
                    value={product.productId || '-'}
                  />
                  <ProductReadOnlyField
                    className="editor-field-4"
                    label="类目（中文显示）"
                    value={product.category || '-'}
                  />
                  <ProductReadOnlyField className="editor-field-4" label="状态" value={product.status || '-'} />
                  <TextField
                    size="small"
                    className="editor-field-2"
                    label="价格"
                    value={form.price}
                    onChange={updateField('price')}
                  />
                  <TextField
                    size="small"
                    className="editor-field-2"
                    label="库存"
                    value={form.stock}
                    onChange={updateField('stock')}
                  />
                  <ProductReadOnlyField
                    className="editor-field-3"
                    label="佣金比例（Ozon）"
                    value={product.commissionText || '-'}
                  />
                  <ProductReadOnlyField
                    className="editor-field-3"
                    label="佣金金额预估"
                    value={product.commissionAmount || '-'}
                  />
                  <ProductReadOnlyField className="editor-field-3" label="收单费" value={product.acquiringFee || '-'} />
                  <TextField
                    size="small"
                    className="editor-field-3"
                    label="产品重量 kg"
                    value={form.weight}
                    onChange={updateField('weight')}
                    disabled={!materialFieldsEditable}
                  />
                  <TextField
                    size="small"
                    className="editor-field-2"
                    label="产品长 cm"
                    value={form.length}
                    onChange={updateField('length')}
                    disabled={!materialFieldsEditable}
                  />
                  <TextField
                    size="small"
                    className="editor-field-2"
                    label="产品宽 cm"
                    value={form.width}
                    onChange={updateField('width')}
                    disabled={!materialFieldsEditable}
                  />
                  <TextField
                    size="small"
                    className="editor-field-2"
                    label="产品高 cm"
                    value={form.height}
                    onChange={updateField('height')}
                    disabled={!materialFieldsEditable}
                  />
                  <TextField
                    select
                    size="small"
                    className="editor-field-3 product-material-source-select"
                    label="材积来源"
                    value={materialSource}
                    onChange={updateField('materialSource')}
                    disabled={materialSource === PRODUCT_MATERIAL_SOURCE_CROSS_BORDER || saving}
                  >
                    {materialSourceOptions.map((source) => (
                      <MenuItem key={source} value={source}>
                        {productMaterialSourceMeta[source]?.label || source}
                      </MenuItem>
                    ))}
                  </TextField>
                  <Button
                    variant="contained"
                    className="editor-field-3 product-bus-read-button"
                    onClick={() => onReadBus?.(displayProduct)}
                    disabled={saving}
                  >
                    读取巴士实测
                  </Button>
                </Box>
              </Box>

              <Box className="product-editor-section product-image-editor">
                <input
                  ref={mainImageInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={uploadImages('images')}
                />
                <input
                  ref={detailImageInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={uploadImages('detailImages')}
                />
                <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" spacing={1.5} mb={1.5}>
                  <Box>
                    <Typography variant="h6">产品图片</Typography>
                    <Typography variant="body2" color="text.secondary">
                      主图/轮播图和详情图分区展示。
                    </Typography>
                  </Box>
                  <Button variant="outlined" onClick={() => mainImageInputRef.current?.click()} disabled={saving}>
                    添加主图
                  </Button>
                </Stack>

                <Box className="product-image-row">
                  <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
                    <Chip size="small" color="primary" variant="outlined" label={mainImageLabel} />
                    {mainImages.length > MIN_PRODUCT_IMAGE_SLOTS ? (
                      <Typography variant="caption" color="text.secondary">
                        向右滑动查看更多
                      </Typography>
                    ) : null}
                  </Stack>
                  <Box className="product-image-strip">
                    {mainImageSlots.map((slot) =>
                      slot.type === 'image' ? (
                        <Box
                          key={slot.key}
                          className={`product-image-card product-image-draggable${activeImageIndex === slot.index ? ' active' : ''}${
                            dragImage?.field === 'images' && dragImage.index === slot.index ? ' dragging' : ''
                          }`}
                          draggable={!saving}
                          onDragStart={startImageDrag('images', slot.index)}
                          onDragOver={allowImageDrop('images', slot.index)}
                          onDrop={dropImage('images', slot.index)}
                          onDragEnd={() => setDragImage(null)}
                        >
                          <IconButton
                            size="small"
                            className="product-image-remove-button"
                            aria-label="删除图片"
                            disabled={saving}
                            onClick={(event) => {
                              event.stopPropagation();
                              removeImage(slot.index);
                            }}
                          >
                            ×
                          </IconButton>
                          <Box
                            component="button"
                            type="button"
                            className="product-image-preview"
                            onClick={() => setActiveImageIndex(slot.index)}
                          >
                            <img src={slot.image} alt={`图 ${slot.index + 1}`} />
                          </Box>
                          <Box className="product-image-card-title">
                            <Typography variant="subtitle1">
                              {slot.index === 0 ? '商品首图' : `图 ${slot.index + 1}`}
                            </Typography>
                          </Box>
                        </Box>
                      ) : (
                        <Box
                          key={slot.key}
                          component="button"
                          type="button"
                          className="product-image-card product-image-empty-card"
                          onClick={() => mainImageInputRef.current?.click()}
                          disabled={saving}
                        >
                          <AddRounded />
                          <Typography variant="subtitle2">上传图片</Typography>
                        </Box>
                      )
                    )}
                  </Box>
                </Box>

                <Box className="product-image-row">
                  <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
                    <Chip size="small" color="warning" variant="outlined" label={detailImageLabel} />
                    {detailImages.length > MIN_PRODUCT_IMAGE_SLOTS ? (
                      <Typography variant="caption" color="text.secondary">
                        向右滑动查看更多
                      </Typography>
                    ) : null}
                  </Stack>
                  <Box className="product-image-strip">
                    {detailImageSlots.map((slot) =>
                      slot.type === 'image' ? (
                        <Box
                          key={slot.key}
                          className={`product-image-card product-image-draggable${
                            dragImage?.field === 'detailImages' && dragImage.index === slot.index ? ' dragging' : ''
                          }`}
                          draggable={!saving}
                          onDragStart={startImageDrag('detailImages', slot.index)}
                          onDragOver={allowImageDrop('detailImages', slot.index)}
                          onDrop={dropImage('detailImages', slot.index)}
                          onDragEnd={() => setDragImage(null)}
                        >
                          <IconButton
                            size="small"
                            className="product-image-remove-button"
                            aria-label="删除图片"
                            disabled={saving}
                            onClick={(event) => {
                              event.stopPropagation();
                              removeDetailImage(slot.index);
                            }}
                          >
                            ×
                          </IconButton>
                          <Box className="product-image-preview">
                            <img src={slot.image} alt={`详情图 ${slot.index + 1}`} />
                          </Box>
                          <Box className="product-image-card-title">
                            <Typography variant="subtitle1">详情图 {slot.index + 1}</Typography>
                          </Box>
                        </Box>
                      ) : (
                        <Box
                          key={slot.key}
                          component="button"
                          type="button"
                          className="product-image-card product-image-empty-card"
                          onClick={() => detailImageInputRef.current?.click()}
                          disabled={saving}
                        >
                          <AddRounded />
                          <Typography variant="subtitle2">上传图片</Typography>
                        </Box>
                      )
                    )}
                  </Box>
                </Box>
              </Box>
            </Box>

            <ProductAttributeEditor
              attributeRows={attributeRows}
              attributeOptionsById={attributeOptionsById}
              attributeOptionsLoading={attributeOptionsLoading}
              loadAttributeOptions={loadAttributeOptions}
              form={form}
              updateAttributeField={updateAttributeField}
              saving={saving}
              attributeLoading={attributeLoading}
              attributeContextMeta={attributeContextMeta}
            />
          </Box>
        </DialogContent>
        <DialogActions className="product-editor-actions">
          <Button onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button variant="contained" color="success" disabled={saving} onClick={() => setSaveConfirmOpen(true)}>
            {saving ? '保存中' : '保存'}
          </Button>
        </DialogActions>
      </Dialog>

      <ProductSaveConfirmDialog
        open={saveConfirmOpen}
        saving={saving}
        onClose={() => setSaveConfirmOpen(false)}
        onConfirm={submitSave}
        saveChangeItems={saveChangeItems}
        changedAttributeRows={changedAttributeRows}
        productCardDiff={productCardDiff}
      />
    </>
  );
}
