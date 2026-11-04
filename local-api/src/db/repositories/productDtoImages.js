import { normalizeText } from "./productDtoValues.js";

export function normalizeImageList(values = []) {
  const output = [];
  const push = (value) => {
    if (Array.isArray(value)) {
      value.forEach(push);
      return;
    }
    if (value && typeof value === "object") {
      push(
        value.url ??
          value.file_name ??
          value.image_url ??
          value.src ??
          value.link,
      );
      return;
    }
    const text = normalizeText(value);
    if (text && !output.includes(text)) output.push(text);
  };
  values.forEach(push);
  return output.slice(0, 30);
}

export function extractPrimaryImage(item = {}) {
  const direct = normalizeImageList([
    item.primary_image,
    item.primaryImage,
    item.primary_photo,
    item.primaryPhoto,
    item.main_image,
    item.mainImage,
    item.image,
    item.picture,
  ])[0];
  if (direct) return normalizeText(direct);
  return (
    normalizeImageList([
      item.images,
      item.pictures,
      item.photo,
      item.photos,
      item.primary_photo,
      item.color_photo,
      item.photo_360,
      item.images360,
      item.color_image,
    ])[0] || ""
  );
}

export function extractImages(item = {}) {
  return normalizeImageList([
    item.primary_image,
    item.primaryImage,
    item.primary_photo,
    item.primaryPhoto,
    item.images,
    item.pictures,
    item.photo,
    item.photos,
    item.color_photo,
    item.photo_360,
    item.images360,
    item.color_image,
    item.image,
    item.picture,
  ]);
}
