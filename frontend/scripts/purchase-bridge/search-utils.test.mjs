import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTaobaoImageSearchUrl, selectTitleCandidate } from './search-utils.mjs';

test('keeps a first-ranked ad when organic visual matches support the same product', () => {
  const selected = selectTitleCandidate([
    { title: '客厅落地多层铁艺花架带轮花盆架', isAd: true },
    { title: '室内铁艺多层花架客厅落地花盆架', isAd: false },
    { title: '阳台落地多层铁艺花架带轮置物架', isAd: false },
    { title: '厨房硅胶锅铲套装', isAd: false },
  ]);

  assert.equal(selected?.title, '客厅落地多层铁艺花架带轮花盆架');
});

test('skips an unrelated paid placement ahead of the real 1688 image matches', () => {
  const selected = selectTitleCandidate([
    { title: '跨境简约餐桌烛台家用烛光晚餐装饰摆件', isAd: true },
    { title: '花架室内置物架铁艺多层带轮落地式花盆架', isAd: false },
    { title: '花架子铁艺花架客厅落地式阳台多层置物架', isAd: false },
    { title: '高端花架子客厅落地式阳台置物架花盆托架', isAd: false },
  ]);

  assert.equal(selected?.title, '花架室内置物架铁艺多层带轮落地式花盆架');
});

test('builds the current Taobao image-search url instead of the retired imgfile route', () => {
  const imageUrl = 'https://ir.ozone.ru/s3/example/product.jpg?size=800';
  const target = new URL(buildTaobaoImageSearchUrl(imageUrl, 'taobao'));

  assert.equal(target.origin + target.pathname, 'https://s.taobao.com/search');
  assert.equal(target.searchParams.get('imgSearchUrl'), imageUrl);
  assert.equal(target.searchParams.get('imgfile'), null);
  assert.equal(target.searchParams.get('tab'), 'all');
  assert.equal(target.searchParams.get('search_type'), 'item');
});

test('keeps the Tmall scope on the current image-search route', () => {
  const imageUrl = 'https://ir.ozone.ru/s3/example/product.jpg';
  const target = new URL(buildTaobaoImageSearchUrl(imageUrl, 'tmall'));

  assert.equal(target.searchParams.get('imgSearchUrl'), imageUrl);
  assert.equal(target.searchParams.get('tab'), 'mall');
});
