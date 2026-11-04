from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any


class PromptTemplateFailure(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class PromptTemplate:
    capability: str
    system: str
    input_label: str


TEMPLATES: dict[str, PromptTemplate] = {
    "product-description.v1": PromptTemplate(
        capability="text.product-description",
        system=(
            "你是 Ozon 商品资料优化助手。只处理输入中的当前商品，不创建或猜测新商品。"
            "标题、描述和属性只能依据真实输入；不得改变 SKU、货号、价格、库存或店铺归属。"
            "缺失事实必须保持未知。严格按输入要求的 JSON 结构输出，不要 Markdown。"
        ),
        input_label="当前商品真实资料",
    ),
    "attribute-autofill.v1": PromptTemplate(
        capability="text.product-description",
        system=(
            "你是 Ozon 商品属性整理器。只使用输入中的商品事实、类目字典和允许值。"
            "不得编造材质、尺寸、认证、品牌或字典值；无法确认时返回待人工确认。"
            "严格返回完整可解析 JSON，不要 Markdown。"
        ),
        input_label="商品事实与属性批次",
    ),
    "profit-order-review.v1": PromptTemplate(
        capability="text.product-description",
        system=(
            "你是 Ozon 跨境电商订单利润与商品投入评估助手。金额和利润必须以输入账本为准，"
            "不得重算或修改金额。明确区分单笔订单、同 SKU 店内历史和外部市场数据；"
            "缺失字段保持未知。只返回一个 JSON 对象，不要 Markdown。"
        ),
        input_label="订单利润与市场只读快照",
    ),
    "image-plan.v1": PromptTemplate(
        capability="text.image-plan",
        system=(
            "你是 Ozon 商品图片方案规划器。参考图只用于确认商品身份、SKU、结构、材质、"
            "配件和包装数量，不能把源平台广告版式、中文广告字、尺寸箭头、价格、销量、"
            "评分、水印或平台界面当成商品本体。必须为每个来源位置独立输出可执行的正向提示词、"
            "负向约束、必须保留项、禁止项和验收项。不得补造品牌、认证、性能、参数、配件或赠品。"
            "买家可见文字只能使用输入中明确给出的简短自然俄语；没有明确俄语文字时保持无文字，"
            "绝对禁止中文营销字、源语言广告字、乱码和中俄混排。极速模式也不得删减这些硬规则。"
            "当 outputMode 为 plans-json 时，必须逐字遵守输入中的 outputContract：只返回一个 JSON 对象，"
            "plans 必须覆盖 sourceImageIndexes 的每个位置，sourceIndex 必须原样返回，且每项必须包含"
            "purpose、prompt、negativePrompt、mustKeep、mustAvoid、acceptanceChecks；不得改用报告、"
            "skuPlans、markdown 或自然语言说明。"
            "必须逐张实际观察对应参考图，并在每个 plan 中明确写出该图直接可见的商品外轮廓、"
            "平面或立体状态、裁切状态、弯折方式、实物数量和相对位置。若参考图是矩形片材、"
            "卷材、半成品或通用件，方案不得要求把它放入会迫使其变形、裁切或变成类目常见成品的场景。"
            "imageSlotInstructions 中每个位置的图片类型、用途、构图和背景属于硬约束；除非该位置明确写了"
            "白底，否则不得把真实场景、细节特写、结构说明、使用演示或卖点总览降级成白底、纯色棚拍或孤立抠图。"
            "若场景中的常规安装方式会迫使商品变形，必须保持同一场景类型，把未变形商品自然放在场景内的"
            "平面、展示区或真实使用位置旁，不得通过取消场景规避商品保真。"
            "参考图可见事实与商品标题、类目常识、其他 SKU 或位置规则冲突时，必须以当前参考图为准。"
            "严格按输入要求返回 JSON；当 outputMode 为 single-execution-prompt 时允许返回一条"
            "EXECUTION_PROMPT，但该提示词仍必须包含全部硬规则。"
        ),
        input_label="图片位置、商品事实与生成要求",
    ),
    "attribute-visual-evidence.v1": PromptTemplate(
        capability="text.image-plan",
        system=(
            "你是商品图片事实识别器。只记录参考图片直接可见的事实，不写营销文案，"
            "不推测图片无法证明的材质、精确尺寸、重量、认证、品牌、兼容性或配件。"
            "字段 ID 和 SKU ID 只能来自输入；同一商品不同 SKU 必须分开。严格返回 JSON。"
        ),
        input_label="参考图片对应的商品、字段与 SKU",
    ),
    "external-ozon-insight.v1": PromptTemplate(
        capability="text.external-insight",
        system=(
            "你是 Ozon 店铺经营分析助手。只依据输入的真实查询结果进行整理、翻译和解释，"
            "不得补造销量、价格、链接、评分、排名或趋势。将事实、推断和数据缺口分开，"
            "严格返回一个 JSON 对象，字段为 title、executiveSummary、marketAssessment、"
            "keyFindings、opportunities、risks、actionPlan、dataGaps。"
            "数组中的行动项使用 priority、title、evidence、action，禁止 Markdown。"
        ),
        input_label="外部查询结果与分析范围",
    ),
    "product-selection.v1": PromptTemplate(
        capability="text.external-insight",
        system=(
            "你是 Ozon 选品分析助手。Ozon 真实市场数据是判断依据，原始输入词是商品边界。"
            "模型只做整理、翻译和解释，不得补造销量、价格、链接、评分或货源事实。"
            "最终货源必须标明需要人工核对。"
        ),
        input_label="Ozon 市场数据、采购候选与商品边界",
    ),
    "performance-ad-insight.v1": PromptTemplate(
        capability="text.external-insight",
        system=(
            "你是 Ozon 广告与经营表现分析助手。先检查数据完整度，再依据真实指标给出结论。"
            "不得补造曝光、点击、订单、花费或归因；所有建议必须能追溯到输入证据。"
        ),
        input_label="广告与经营指标快照",
    ),
    "operational-report.v1": PromptTemplate(
        capability="text.external-insight",
        system=(
            "你是 Ozon 店铺经营报告助手。交叉分析销售、库存、费用和售后真实数据，"
            "金额保持原口径，不得编造缺失数据。输出结论、依据、风险、动作和数据缺口。"
        ),
        input_label="店铺经营只读快照",
    ),
    "data-analysis.v1": PromptTemplate(
        capability="text.external-insight",
        system=(
            "你是 Ozon 店铺经营分析助手。只分析当前 SQLite 报表快照中的真实数据，"
            "不得触发刷新、修改业务数据或补造指标。金额、数量和时间范围必须保持输入口径。"
        ),
        input_label="当前报表紧凑快照",
    ),
    "product-selection-source-plan.v1": PromptTemplate(
        capability="text.external-insight",
        system=(
            "你是 Ozon 到 1688 的采购搜索词规划器。中文采购词必须来自 Ozon 同类热销商品"
            "和输入商品边界，不得跨类目扩展，不得编造货源链接、价格或销量。"
        ),
        input_label="Ozon 商品边界与同类商品事实",
    ),
    "generic-skill-runtime.v1": PromptTemplate(
        capability="text.external-insight",
        system=(
            "你是通用 Skill 只读运行器。只执行输入中给出的 Skill 流程，并且只能依据本次绑定输入、"
            "当前店铺和商品的公开事实、以及真实接口回读数据作答。缺少证据的字段必须写“待确认”；"
            "不得补造指标、价格、属性、图片、认证、链接、接口结果或执行记录。"
            "本次运行只允许分析、整理和生成草稿；不得声称已经发布、写入、删除、下单、发送、扣费"
            "或修改任何业务数据。严格返回一个 JSON 对象，不要 Markdown 或 JSON 之外的文字。"
            "对象字段固定为 statusLabel、summary、sections、nextActions；sections 至少一项，"
            "每项字段为 title 和 rows，rows 必须是字符串数组，nextActions 也必须是字符串数组。"
        ),
        input_label="Skill 定义、绑定上下文与真实接口回读",
    ),
}


def render_server_prompt(
    *,
    capability: str,
    template_id: str,
    template_input: dict[str, Any],
    custom_rules: str = "",
    user_instruction: str = "",
) -> tuple[str, str]:
    template = TEMPLATES.get(template_id)
    if template is None:
        raise PromptTemplateFailure(
            "PROMPT_TEMPLATE_NOT_FOUND",
            "服务器没有找到本次功能的提示词模板。",
        )
    if template.capability != capability:
        raise PromptTemplateFailure(
            "PROMPT_TEMPLATE_CAPABILITY_MISMATCH",
            "提示词模板与模型能力不匹配。",
        )
    if not isinstance(template_input, dict) or not template_input:
        raise PromptTemplateFailure(
            "PROMPT_TEMPLATE_INPUT_REQUIRED",
            "本次分析缺少结构化真实数据。",
        )
    serialized = json.dumps(
        template_input,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    if len(serialized) > 120_000:
        raise PromptTemplateFailure(
            "PROMPT_TEMPLATE_INPUT_TOO_LARGE",
            "本次分析数据过大，请缩小范围后重试。",
        )
    system_parts = [template.system]
    normalized_rules = str(custom_rules or "").strip()
    if normalized_rules:
        system_parts.append(f"用户在工具设置中保存的附加规则：\n{normalized_rules[:12_000]}")
    user_parts = [f"{template.input_label}：\n{serialized}"]
    normalized_instruction = str(user_instruction or "").strip()
    if normalized_instruction:
        user_parts.append(f"用户本次补充要求：\n{normalized_instruction[:8_000]}")
    return "\n\n".join(system_parts), "\n\n".join(user_parts)


def _image_text(value: Any) -> str:
    return str(value or "").strip()


def _image_list(value: Any, limit: int = 24) -> list[str]:
    if not isinstance(value, list):
        return []
    return [text for item in value if (text := _image_text(item))][:limit]


def _image_position_rule(value: Any, group: str, source_index: int) -> dict[str, Any]:
    if not isinstance(value, dict) or not isinstance(value.get(group), list):
        return {}
    for index, item in enumerate(value[group]):
        if not isinstance(item, dict):
            continue
        explicit = item.get("sourceIndex")
        legacy = item.get("position")
        normalized = (
            int(explicit)
            if isinstance(explicit, int) and explicit >= 0
            else int(legacy) - 1
            if isinstance(legacy, int) and legacy > 0
            else index
        )
        if normalized == source_index:
            return item
    return {}


def _image_skill_policy_lines(value: Any) -> list[str]:
    if not isinstance(value, dict) or _image_text(value.get("toolId")) != "ozon-product-image-generation":
        return []
    lines: list[str] = []
    version = _image_text(value.get("policyVersion"))
    if version:
        lines.append(f"统一 Skill 规则版本：{version}。")
    sections = (
        ("Skill 安全规则", "safetyRules", 60),
        ("Skill SKU 规则", "skuImageRules", 40),
        ("Skill 证据规则", "evidenceRules", 60),
        ("Skill 验收规则", "qaRules", 60),
        ("Skill 停止条件", "stopConditions", 40),
        ("Skill 输出规则", "outputRules", 40),
    )
    for label, key, limit in sections:
        items = _image_list(value.get(key), limit)
        if items:
            lines.append(f"{label}：{'；'.join(items)}。")
    return lines


def render_server_image_prompt(*, template_id: str, template_input: dict[str, Any]) -> str:
    if template_id != "product-image-generation.v1":
        raise PromptTemplateFailure(
            "IMAGE_PROMPT_TEMPLATE_NOT_FOUND",
            "服务器没有找到本次图片提示词模板。",
        )
    if not isinstance(template_input, dict) or not template_input:
        raise PromptTemplateFailure(
            "IMAGE_PROMPT_TEMPLATE_INPUT_REQUIRED",
            "本次生图缺少结构化商品事实。",
        )
    product = (
        template_input.get("product") if isinstance(template_input.get("product"), dict) else {}
    )
    image = template_input.get("image") if isinstance(template_input.get("image"), dict) else {}
    group = "detail" if image.get("group") == "detail" else "main"
    raw_index = image.get("sourceIndex")
    source_index = max(0, int(raw_index) if isinstance(raw_index, int | float) else 0)
    position = _image_position_rule(template_input.get("positionRules"), group, source_index)
    approved = (
        template_input.get("approvedPlan")
        if isinstance(template_input.get("approvedPlan"), dict)
        else {}
    )
    plans = approved.get("items") if isinstance(approved.get("items"), list) else []
    skill_policy_lines = _image_skill_policy_lines(template_input.get("skillContext"))
    plan = next(
        (
            item
            for item in plans
            if isinstance(item, dict) and item.get("sourceIndex") == source_index
        ),
        {},
    )
    position_text = " ".join(
        filter(
            None, (_image_text(position.get("purpose")), _image_text(position.get("instructions")))
        )
    )
    white_background = any(
        token in position_text.lower() for token in ("白底", "纯白背景", "white background")
    )
    has_position_rule = bool(
        position_text
        or _image_text(position.get("visibleText"))
        or _image_text(position.get("mustAvoid"))
    )
    target_scene = _image_text(product.get("targetScene"))
    sku_facts = _image_text(product.get("skuFacts")) or "只使用参考图中直接可确认的事实"
    lines = [
        (
            "生成一张 3:4 竖版俄罗斯电商详情图，当前图片只解释一个有证据的卖点。"
            if group == "detail"
            else "生成一张 3:4 竖版俄罗斯电商主图，商品主体清晰、完整、醒目。"
        ),
        f"当前固定位置：{'详情图' if group == 'detail' else '主图'} {source_index + 1}。",
        f"商品名称：{_image_text(product.get('title'))}。"
        if _image_text(product.get("title"))
        else "",
        f"商品主键：{_image_text(product.get('productKey'))}。"
        if _image_text(product.get("productKey"))
        else "",
        f"商品货号：{_image_text(product.get('offerId'))}。"
        if _image_text(product.get("offerId"))
        else "",
        f"商品 ID：{_image_text(product.get('productId'))}。"
        if _image_text(product.get("productId"))
        else "",
        f"当前 SKU：{_image_text(product.get('sku'))}。" if _image_text(product.get("sku")) else "",
        f"当前 SKU 事实：{sku_facts}。",
        (
            "图片类型硬约束：当前位置明确要求标准白底图，背景保持干净、均匀，不增加场景道具。"
            if white_background
            else "图片类型硬约束：必须执行当前位置规定的用途、构图和背景。除非当前位置明确写了白底，"
            "否则严禁改成白底、纯色棚拍、孤立抠图或普通商品陈列图。"
            if has_position_rule
            else "背景必须符合商品真实用途。"
        ),
        f"页面级目标：{target_scene}；该通用目标不得覆盖当前位置的具体图片类型。"
        if target_scene
        else "",
        f"位置用途：{_image_text(position.get('purpose'))}。"
        if _image_text(position.get("purpose"))
        else "",
        f"构图和背景：{_image_text(position.get('instructions'))}。"
        if _image_text(position.get("instructions"))
        else "",
        f"允许出现的文字：{_image_text(position.get('visibleText'))}。"
        if _image_text(position.get("visibleText"))
        else "",
        f"当前位置额外禁止：{_image_text(position.get('mustAvoid'))}。"
        if _image_text(position.get("mustAvoid"))
        else "",
        f"已审核的本位置方案：{_image_text(plan.get('prompt'))}"
        if _image_text(plan.get("prompt"))
        else "",
        f"已审核的负向约束：{_image_text(plan.get('negativePrompt'))}"
        if _image_text(plan.get("negativePrompt"))
        else "",
        f"必须保留：{'；'.join(_image_list(plan.get('mustKeep')))}。"
        if _image_list(plan.get("mustKeep"))
        else "",
        f"必须避免：{'；'.join(_image_list(plan.get('mustAvoid')))}。"
        if _image_list(plan.get("mustAvoid"))
        else "",
        f"生成后验收：{'；'.join(_image_list(plan.get('acceptanceChecks')))}。"
        if _image_list(plan.get("acceptanceChecks"))
        else "",
        f"全局负向约束：{_image_text(approved.get('globalNegativePrompt'))}"
        if _image_text(approved.get("globalNegativePrompt"))
        else "",
        *skill_policy_lines,
        "这是高保真参考图编辑，不是根据商品名称重新设计商品。把参考图中的商品本体视为已锁定且不可重绘的前景图层，该锁定前景图层是唯一视觉锚点；只允许编辑商品以外的背景和后加广告层，禁止重新生成、重新裁切、拟合、修形或补画商品本体。",
        "商品保真和当前位置图片类型是两组同时必须满足的硬约束。若指定场景中的常规安装或摆放方式会迫使商品改变轮廓、裁切状态、平面或立体状态、数量或相对位置，必须保持同一场景类型，把锁定商品自然放置在该场景的平面、展示区或真实使用位置旁；不得取消场景，也不得自行降级成白底或纯色背景。",
        "必须逐件保持参考图中可见商品的精确外轮廓、平面或立体状态、裁切状态、弯折方式、数量、相对位置、比例、颜色、材质纹理、边缘和全部部件。",
        "如果参考图展示的是平整片材、矩形商品、卷材、半成品或通用件，成图必须保持同一物理形态，严禁改成预裁切、立体、定制轮廓或类目中常见的成型商品。",
        "标题里的包装数量、系统中的 SKU 种类数以及其他 SKU 名称中的数字都不是当前画面的视觉事实。画面商品数量只能等于当前参考图直接可见且可确认的实物数量；无法确认时不得新增数字、复制商品或写数量。",
        "参考图只提供商品事实，不是可以直接照搬的广告模板；必须重新组织背景、构图和信息层级。",
        "必须区分商品本体与源平台后加的广告层。中文或其他源语言广告字、尺寸箭头、价格、折扣、销量、评分、二维码、水印、平台标识和广告底板都属于广告层，必须从最终画面完全清除。",
        "商品外观以参考图为唯一视觉事实来源；文字标题、类目常识和其他 SKU 与参考图冲突时，一律服从当前参考图。颜色、形状、结构、材质、接口、零件、数量、比例、包装以及商品本体上真实存在的物理图案不得改变；广告层不属于商品表面图案。",
        "不得新增、删除、替换或复制商品、配件、赠品、人物、包装或功能。",
        "可见文字只能使用当前位置明确给出的准确俄语；没有明确给出俄语文字时，最终图片保持无文字。绝对禁止中文买家可见文字、源语言广告字、乱码、中俄混排和模型自由编造文字。",
        "不得复制源平台的广告版式、背景、标签样式和信息排布，不得把原图中文翻成俄语后原位照抄。",
        "未经当前位置规则和商品事实共同确认，不得生成尺寸线、尺寸箭头、厘米/毫米数值、容量、数量或其他参数。",
        "不得伪造品牌、认证、专利、原装、性能、保修或医疗承诺。",
        "不得出现价格、折扣、销量、评分、评论、二维码、联系方式、平台界面、明水印、工厂或仓库宣传。",
        "交付前必须自检：无源平台广告、无中文或乱码；商品身份和当前 SKU 完全一致；图片职责、场景类型与当前位置一致；俄语文字准确可读。文字无法可靠生成时只移除文字，必须保留当前位置规定的图片类型；非白底位置不得退回白底或纯色背景。",
        (
            "极速模式只压缩软性摄影描述，以上商品事实和禁止项必须完整执行。"
            if template_input.get("generationMode") == "fast"
            else "优先保证商品事实一致，再优化摄影构图、灯光和电商可读性。"
        ),
    ]
    local_plan = _image_list(template_input.get("localPlan"), 12)
    if local_plan:
        lines.append(f"本地草稿补充：{'；'.join(local_plan)}")
    prompt = "\n".join(filter(None, lines))
    if len(prompt) > 24_000:
        raise PromptTemplateFailure(
            "IMAGE_PROMPT_TEMPLATE_TOO_LARGE",
            "本次图片规则过多，请缩小后重试。",
        )
    return prompt
