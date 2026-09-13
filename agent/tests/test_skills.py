from agent.app import skills


def test_load_skill_body_strips_frontmatter():
    body = skills.load_skill_body(skills.WIZARD_FLOW_SKILL)
    assert "Reasonable clarification test" in body
    assert "Point of no return" in body
    assert not body.startswith("---")
    assert "name: wizard-flow" not in body


def test_load_widget_examples_skill():
    body = skills.load_skill_body(skills.WIDGET_EXAMPLES_SKILL)
    assert "water-fountains-nyc" in body
    assert "anymaps.ready()" in body
    assert '"done": true' in body


def test_wizard_flow_skill_requires_source_scoping():
    body = skills.load_skill_body(skills.WIZARD_FLOW_SKILL)
    assert "Geographic scope" in body
    assert "scope in the external source itself" in body


def test_examples_skill_documents_plan_shape():
    body = skills.load_skill_body(skills.WIDGET_EXAMPLES_SKILL)
    assert '"plan"' in body
    assert '"sources"' in body
    assert '"auth"' in body


def test_wizard_flow_skill_guides_secrets():
    body = skills.load_skill_body(skills.WIZARD_FLOW_SKILL)
    assert "Never claim an API needs no key" in body
    assert "plan.sources" in body


def test_wizard_flow_skill_references_authoritative_sources_not_generation_contract():
    body = skills.load_skill_body(skills.WIZARD_FLOW_SKILL)
    assert "generation contract" not in body
    assert "CONTRACTS.md" in body
