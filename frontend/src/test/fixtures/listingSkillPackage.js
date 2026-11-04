// Original synthetic parser fixture. No third-party skill package is embedded.
export const listingSkillPackage = {
  title: 'Ozon 商品卡优化与生图',
  name: 'synthetic-ozon-listing',
  description: 'Synthetic Ozon product, SKU, SEO and image generation workflow.',
  installType: 'skill-md',
  sourceUrl: 'https://example.invalid/synthetic-ozon-listing',
  body: `## Inputs
- 处理模式
- 店铺、市场与语言
- 商品、SPU/SKC 与 SKU 信息
- 参考图授权与生图范围

## Operating modes
- full card — prepare all outputs
- step4 images — prepare selected images

## Capabilities
- Read Ozon products and product images; generate SEO and images.

## Workflow
- Read facts, check evidence, create a plan, obtain permission, generate, review.

## Notes
Synthetic parser coverage.
`,
  referenceFiles: [
    { path: 'README.md', content: '## 安装\nLoad this synthetic fixture.\n\n## Notes\nOffline tests only.\n\n## Changelog\nInitial synthetic sample.' },
    { path: 'references/image-set.md', content: `## Six differentiated jobs
1. **Primary/CTR image**: Present the supplied object. Use a short Russian headline. No price or discount labels.
2. **Structure image**: Show confirmed structural details. No invented parts.
3. **Dimension/specification image**: Label verified measurements. Never guess missing dimensions.
4. **Material/detail image**: Show visible texture. No unsupported claims.
5. **Function/use image**: Demonstrate the stated use without exaggeration.
6. **Best remaining decision aid**: Address another buyer concern. Must differ from slots 1-5.

## SKU images
- Produce one image for every real SKU using its own authorized reference.

## Image generation
- If image generation is requested, use $imagegen after confirmation.
- If reusable styles are requested, use $ozon-step4-prompt-library for the requested style.
` },
    { path: 'references/facts.md', content: '## Product truth\nRecord observed facts.\n\n## SKU matrix readiness\nKeep variant identifiers separate.\n\n## Evidence\nAdapt only interview behavior from $grill-me; ask about missing facts.' },
    { path: 'references/search.md', content: '## Search evidence\nRead dated Ozon search analytics and CTR without inventing trends.' },
    { path: 'references/copy.md', content: '## SEO\nWrite factual Russian product titles.\n\n## Attributes\nCross-check attributes and variant facts.' },
    { path: 'references/output.md', content: '## Outputs\nReturn the reviewed content and six images.\n\n## QA\nReject structural drift. Check Russian spelling.\n\n## Post-launch evidence\nCompare dated analytics.\n\n## Workflow\nFor project work, use $drive-cross-border-ecommerce only when requested.' },
    { path: 'references/control.md', content: '## Safety\nKeep credentials private; do not publish automatically.\n\n## Stop conditions\nStop before generation if reference rights are absent.\n\n## Notes\nAll data is synthetic.' },
  ],
  executableFiles: [],
};
