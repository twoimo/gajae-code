from __future__ import annotations

import pytest

from gjc_rpc import RpcClient



@pytest.mark.parametrize(
    "kwargs",
    [
        {"user": 2001},
        {"group": "gjc"},
        {"extra_groups": [2000, "docker"]},
    ],
)
def test_subprocess_user_group_options_are_outside_thin_uds_client(kwargs):
    client = RpcClient(**kwargs)
    assert client._process is None
    assert client.command[:3] == ("gjc", "--mode", "rpc-daemon-worker")


def test_legacy_subprocess_flag_keeps_subprocess_user_group_options():
    client = RpcClient(use_legacy_subprocess=True, user=2001, group="gjc", extra_groups=[])
    assert client.command[:3] == ("gjc", "--mode", "rpc-daemon-worker")
    assert client._process is None
