from shared.http import DEFAULT_USER_AGENT, with_user_agent


def test_with_user_agent_adds_default_when_missing():
    assert with_user_agent(None) == {"User-Agent": DEFAULT_USER_AGENT}
    assert with_user_agent({"X-Test": "1"}) == {
        "X-Test": "1",
        "User-Agent": DEFAULT_USER_AGENT,
    }


def test_with_user_agent_preserves_existing_case_insensitively():
    assert with_user_agent({"user-agent": "custom/1.0"}) == {"user-agent": "custom/1.0"}
    assert with_user_agent({"USER-AGENT": "custom/1.0"}) == {"USER-AGENT": "custom/1.0"}
