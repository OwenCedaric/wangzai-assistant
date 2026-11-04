using System.Text.Json;

namespace Wangzai.CefBrowserHost;

internal static class OzonSellerOrderOpenScript
{
	public static string Build(string postingNumber)
	{
		string postingJson = JsonSerializer.Serialize(postingNumber);
		return $$"""
(async () => {
  const posting = {{postingJson}};
  const clean = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim();
  const lower = (value) => clean(value).toLocaleLowerCase();
  const visible = (node) => {
    if (!node || !node.isConnected) return false;
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && Number(style.opacity || 1) > 0
      && rect.width > 2
      && rect.height > 2;
  };
  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const deadlineWait = async (read, milliseconds, interval = 180) => {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) {
      const value = read();
      if (value) return value;
      await wait(interval);
    }
    return null;
  };
  const fireClick = (node) => {
    if (!node || !visible(node)) return false;
    node.scrollIntoView({ block: 'center', inline: 'nearest' });
    const options = { bubbles: true, cancelable: true, view: window };
    if (typeof PointerEvent === 'function') {
      node.dispatchEvent(new PointerEvent('pointerdown', options));
      node.dispatchEvent(new PointerEvent('pointerup', options));
    }
    node.dispatchEvent(new MouseEvent('mousedown', options));
    node.dispatchEvent(new MouseEvent('mouseup', options));
    if (typeof node.click === 'function') node.click();
    else node.dispatchEvent(new MouseEvent('click', options));
    return true;
  };
  const sellerOrderPath = /^\/app\/postings(?:\/(?:fbs|fbo|rfbs))?(?:\/|$)/iu.test(location.pathname);
  if (!sellerOrderPath) {
    return JSON.stringify({ ok: false, exact: false, reason: 'page-required', posting, pageUrl: location.href });
  }

  const exactLeaf = () => {
    const nodes = [...document.querySelectorAll('a,button,[role="link"],[role="row"],tr,li,td,div,span')];
    return nodes
      .filter((node) => visible(node) && clean(node.textContent).includes(posting))
      .sort((left, right) => clean(left.textContent).length - clean(right.textContent).length)[0] || null;
  };
  const findOrderHeader = () => [...document.querySelectorAll('th,[role="columnheader"],div,span')]
    .filter((node) => visible(node) && /货件编号|订单号|номер\s+отправ|номер\s+заказ|posting|shipment\s+number/iu.test(clean(node.textContent)))
    .sort((left, right) => clean(left.textContent).length - clean(right.textContent).length)[0] || null;
  const exactSurface = () => {
    const encoded = encodeURIComponent(posting).toLocaleLowerCase();
    const address = location.href.toLocaleLowerCase();
    if (address.includes(encoded) || address.includes(posting.toLocaleLowerCase())) return 'url';
    const surfaces = [...document.querySelectorAll('[role="dialog"],[role="region"],main h1,main h2,main h3,aside,[class*="drawer" i],[class*="modal" i],[class*="detail" i],[data-testid*="drawer" i],[data-testid*="detail" i]')];
    return surfaces.some((node) => visible(node) && clean(node.textContent).includes(posting)) ? 'detail' : '';
  };
  if (exactSurface()) {
    return JSON.stringify({ ok: true, exact: true, opened: true, posting, pageUrl: location.href, confirmation: exactSurface() });
  }

  // The Seller shell is interactive several seconds before the virtual order
  // table exists.  Wait for the real target row or its exact order-number
  // header; otherwise a cold page is incorrectly reported as a failed lookup.
  await deadlineWait(() => exactLeaf() || findOrderHeader(), 20000, 220);

  const activateExactOrder = async (leaf) => {
    if (!leaf) return null;
    const row = leaf.closest('[role="row"],tr,li') || leaf.parentElement;
    const rowLinks = row
      ? [...row.querySelectorAll('a[href],button,[role="link"],[tabindex]')].filter(visible)
      : [];
    const interactive = leaf.closest('a[href],button,[role="link"],[tabindex]')
      || rowLinks.find((node) => clean(node.textContent).includes(posting))
      || rowLinks.find((node) => node.tagName === 'A' && node.hasAttribute('href'))
      || leaf;
    if (!visible(interactive)) return null;
    interactive.scrollIntoView({ block: 'center', inline: 'nearest' });
    await wait(350);
    if (!visible(interactive)) return null;
    let rect = interactive.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > window.innerHeight) {
      let scrollParent = interactive.parentElement;
      while (scrollParent && scrollParent !== document.body) {
        const style = getComputedStyle(scrollParent);
        if (scrollParent.scrollHeight > scrollParent.clientHeight + 4 && /(auto|scroll|overlay)/iu.test(style.overflowY)) break;
        scrollParent = scrollParent.parentElement;
      }
      if (scrollParent && scrollParent !== document.body) {
        const parentRect = scrollParent.getBoundingClientRect();
        scrollParent.scrollTop += rect.top - parentRect.top - (scrollParent.clientHeight - rect.height) / 2;
        scrollParent.dispatchEvent(new Event('scroll', { bubbles: true }));
      } else {
        window.scrollBy({ top: rect.top - (window.innerHeight - rect.height) / 2, left: 0, behavior: 'instant' });
      }
      await wait(450);
      rect = interactive.getBoundingClientRect();
    }
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    if (centerX < 0 || centerY < 0 || centerX > window.innerWidth || centerY > window.innerHeight) {
      return {
        ok: false, exact: false, opened: false, reason: 'open-failed', posting, pageUrl: location.href,
      };
    }
    interactive.focus();
    fireClick(interactive);
    const confirmation = await deadlineWait(exactSurface, 12000, 200);
    if (confirmation) {
      return { ok: true, exact: true, opened: true, posting, pageUrl: location.href, confirmation };
    }
    return {
      ok: false, exact: false, opened: false, reason: 'open-failed', posting, pageUrl: location.href,
    };
  };

  const alreadyListed = exactLeaf();
  if (alreadyListed) {
    return JSON.stringify((await activateExactOrder(alreadyListed))
      || { ok: false, exact: false, opened: false, reason: 'open-failed', posting, pageUrl: location.href });
  }

  // Ozon remembers the last status tab for this browser profile.  Searching
  // while that tab is still "waiting for shipment" cannot find a cancelled or
  // completed posting, so always enter the visible "all" status before the
  // exact posting lookup.  This is a read-only UI filter, not an order action.
  const statusContextMarkers = /等待备货|等待发运|运输中|具争议|已签收|已取消|ожида|достав|отмен|в пути/iu;
  const allStatusCandidates = [...document.querySelectorAll('button,a,[role="tab"],[role="button"],[tabindex],div,span')]
    .filter((node) => visible(node) && /^(所有|все|all)$/iu.test(clean(node.textContent)))
    .map((node) => {
      const interactive = node.closest('button,a,[role="tab"],[role="button"],[tabindex]') || node;
      let scope = interactive.parentElement;
      let contextScore = 0;
      for (let depth = 0; scope && depth < 4; depth += 1, scope = scope.parentElement) {
        if (statusContextMarkers.test(clean(scope.textContent))) contextScore += 20;
      }
      if (interactive.getAttribute('role') === 'tab') contextScore += 30;
      return { node: interactive, score: contextScore };
    })
    .sort((left, right) => right.score - left.score);
  const allStatus = allStatusCandidates.find((entry) => entry.score >= 20)?.node || null;
  if (allStatus && allStatus.getAttribute('aria-selected') !== 'true') {
    fireClick(allStatus);
    await deadlineWait(findOrderHeader, 12000, 200);
  }

  const searchMarkers = ['search', 'поиск', 'найти', 'заказ', 'отправлен', 'posting', 'order', '货件', '订单', '搜索'];
  const textControls = () => [...document.querySelectorAll('input,textarea,[role="searchbox"],[role="textbox"],[contenteditable="true"]')]
    .filter((control) => visible(control) && !control.disabled && !control.readOnly);
  const scoreInput = (control) => {
    if (!visible(control) || control.disabled || control.readOnly) return -1;
    const type = lower(control.getAttribute('type'));
    if (type && !['text', 'search'].includes(type)) return -1;
    const evidence = lower([
      control.getAttribute('placeholder'), control.getAttribute('aria-label'), control.getAttribute('name'),
      control.getAttribute('title'), control.id,
    ].join(' '));
    let score = type === 'search' || control.getAttribute('role') === 'searchbox' ? 20 : 0;
    for (const marker of searchMarkers) if (evidence.includes(marker)) score += 10;
    return score;
  };
  const preferredSearchInput = () => {
    const candidates = textControls()
      .map((input) => ({ input, score: scoreInput(input) }))
      .filter((entry) => entry.score >= 10)
      .sort((left, right) => right.score - left.score);
    return candidates[0]?.input || null;
  };
  let searchInput = await deadlineWait(preferredSearchInput, 1200, 200);
  if (!searchInput) {
    const orderHeader = await deadlineWait(findOrderHeader, 15000, 200);
    const headerRect = orderHeader?.getBoundingClientRect() || null;
    const expandableHeader = orderHeader?.matches?.('[aria-expanded]')
      ? orderHeader
      : orderHeader?.querySelector?.('[aria-expanded]') || null;
    const explicitHeaderTrigger = expandableHeader?.querySelector?.('button,[role="button"]')
      || (expandableHeader?.matches?.('button,[role="button"]') ? expandableHeader : null)
      || orderHeader?.querySelector?.('button,[role="button"]')
      || null;
    const headerSearchGlyph = explicitHeaderTrigger
      ? [...explicitHeaderTrigger.querySelectorAll('svg')].filter(visible).at(-1) || null
      : null;
    const headerCandidates = [];
    let headerContainer = orderHeader;
    for (let depth = 0; headerContainer && depth < 6; depth += 1, headerContainer = headerContainer.parentElement) {
      for (const child of headerContainer.querySelectorAll('button,[role="button"],[tabindex],svg')) {
        const candidate = child.closest('button,[role="button"],[tabindex]') || child.parentElement || child;
        if (!visible(candidate) || headerCandidates.includes(candidate)) continue;
        const rect = candidate.getBoundingClientRect();
        if (!headerRect || rect.left + rect.width / 2 < headerRect.right - 4) continue;
        if (Math.abs((rect.top + rect.height / 2) - (headerRect.top + headerRect.height / 2)) > 44) continue;
        if (rect.width > 80 || rect.height > 80) continue;
        headerCandidates.push(candidate);
      }
      if (headerCandidates.length) break;
    }
    const headerTrigger = headerCandidates
      .sort((left, right) => left.getBoundingClientRect().left - right.getBoundingClientRect().left)[0] || null;
    let coordinateTrigger = null;
    if (!headerTrigger && headerRect) {
      const point = document.elementFromPoint(
        Math.min(window.innerWidth - 4, headerRect.right + 18),
        headerRect.top + headerRect.height / 2,
      );
      coordinateTrigger = point?.closest?.('button,[role="button"],[tabindex]') || point || null;
    }
    // The magnifier is rendered as the last SVG inside the column-label button;
    // other blank submit buttons on the same row include the table settings cog.
    const trigger = headerSearchGlyph || explicitHeaderTrigger || coordinateTrigger || headerTrigger;
    if (trigger) {
      const rect = trigger.getBoundingClientRect();
      return JSON.stringify({
        ok: false, exact: false, opened: false, reason: 'native-click-required', clickKind: 'search',
        posting, pageUrl: location.href,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      });
    }
  }
  if (!searchInput) {
    return JSON.stringify({ ok: false, exact: false, reason: 'search-not-ready', posting, pageUrl: location.href });
  }

  searchInput.scrollIntoView({ block: 'center', inline: 'nearest' });
  searchInput.focus();
  if (searchInput.isContentEditable) {
    searchInput.textContent = posting;
  } else {
    const prototype = searchInput instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const valueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (valueSetter) valueSetter.call(searchInput, posting);
    else searchInput.value = posting;
  }
  searchInput.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: posting }));
  searchInput.dispatchEvent(new Event('change', { bubbles: true }));
  searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
  searchInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
  const form = searchInput.closest('form');
  if (form && typeof form.requestSubmit === 'function') form.requestSubmit();

  const resultLeaf = await deadlineWait(exactLeaf, 18000, 250);
  if (!resultLeaf) {
    return JSON.stringify({ ok: false, exact: false, reason: 'not-found', posting, pageUrl: location.href });
  }
  return JSON.stringify((await activateExactOrder(resultLeaf))
    || { ok: false, exact: false, opened: false, reason: 'open-failed', posting, pageUrl: location.href });
})()
""";
	}
}
