from app.core_v2.prompt_registry import render_server_image_prompt, render_server_prompt


def test_text_template_renders_server_owned_external_report_contract():
    system, user = render_server_prompt(
        capability="text.external-insight",
        template_id="external-ozon-insight.v1",
        template_input={"records": [{"销量": 3}]},
    )
    assert "executiveSummary" in system
    assert "销量" in user


def test_generic_skill_runtime_template_is_server_owned_and_read_only():
    system, user = render_server_prompt(
        capability="text.external-insight",
        template_id="generic-skill-runtime.v1",
        template_input={
            "skill": {"title": "商品内容整理", "workflowSteps": ["读取事实", "生成草稿"]},
            "context": {"product": {"title": "保温杯"}},
        },
    )
    assert "通用 Skill 只读运行器" in system
    assert "不得声称已经发布" in system
    assert "statusLabel" in system
    assert "商品内容整理" in user
    assert "保温杯" in user


def test_image_template_renders_from_structured_product_facts():
    prompt = render_server_image_prompt(
        template_id="product-image-generation.v1",
        template_input={
            "generationMode": "fast",
            "product": {
                "title": "黑色保温杯",
                "productKey": "BX-500",
                "sku": "SKU-BLACK",
                "skuFacts": "黑色，500ml",
            },
            "image": {"group": "detail", "sourceIndex": 1},
            "positionRules": {
                "detail": [
                    {},
                    {"purpose": "杯盖特写", "visibleText": "Герметичная крышка"},
                ]
            },
            "approvedPlan": {
                "items": [{"sourceIndex": 1, "prompt": "侧面近景", "mustKeep": ["黑色杯盖"]}]
            },
            "skillContext": {
                "policyVersion": "ozon-product-image-skill.v1",
                "toolId": "ozon-product-image-generation",
                "safetyRules": ["禁止复制源图中文广告"],
                "qaRules": ["检查俄语拼写"],
            },
        },
    )
    assert "详情图 2" in prompt
    assert "BX-500" in prompt
    assert "SKU-BLACK" in prompt
    assert "Герметичная крышка" in prompt
    assert "黑色杯盖" in prompt
    assert "极速模式" in prompt
    assert "禁止复制源图中文广告" in prompt
    assert "检查俄语拼写" in prompt
    assert "必须从最终画面完全清除" in prompt
    assert "广告层不属于商品表面图案" in prompt
    assert "绝对禁止中文买家可见文字" in prompt
    assert "唯一视觉锚点" in prompt
    assert "平整片材、矩形商品、卷材、半成品或通用件" in prompt
    assert "SKU 种类数" in prompt
    assert "图片类型硬约束" in prompt
    assert "非白底位置不得退回白底或纯色背景" in prompt


def test_image_template_keeps_configured_scene_type_with_locked_product_shape():
    prompt = render_server_image_prompt(
        template_id="product-image-generation.v1",
        template_input={
            "product": {"title": "汽车脚垫片材", "targetScene": "Ozon 商品主图"},
            "image": {"group": "main", "sourceIndex": 3},
            "positionRules": {
                "main": [
                    {
                        "sourceIndex": 3,
                        "purpose": "真实使用场景图",
                        "instructions": "放入真实汽车使用场景",
                    }
                ]
            },
            "approvedPlan": {
                "items": [{"sourceIndex": 3, "prompt": "汽车内真实场景"}]
            },
        },
    )
    assert "必须执行当前位置规定的用途、构图和背景" in prompt
    assert "不得取消场景" in prompt
    assert "页面级目标：Ozon 商品主图；该通用目标不得覆盖当前位置" in prompt
    assert "场景规则自动失效" not in prompt


def test_image_plan_template_forbids_copying_source_advertising():
    system, _ = render_server_prompt(
        capability="text.image-plan",
        template_id="image-plan.v1",
        template_input={"productTitle": "汽车脚垫", "sourceImageIndexes": [0]},
    )
    assert "不能把源平台广告版式" in system
    assert "绝对禁止中文营销字" in system
    assert "极速模式也不得删减" in system
    assert "outputContract" in system
    assert "sourceIndex 必须原样返回" in system
    assert "imageSlotInstructions" in system
    assert "不得把真实场景" in system
