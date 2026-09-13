from agent.app import skills


def test_load_skill_body_strips_frontmatter():
    body = skills.load_skill_body(skills.WIZARD_FLOW_SKILL)
    assert "Reasonable clarification test" in body
    assert "Point of no return" in body
    assert not body.startswith("---")
    assert "name: wizard-flow" not in body
