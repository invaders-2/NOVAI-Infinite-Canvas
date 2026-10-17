"""F2 回归：不再向用户配置下发内置 RunningHub 默认工作流；老配置里遗留的空壳记录会被清理。

背景：这两个内置默认工作流（2058541134623891458 / 2058554058318897153）在上游已失效，
配置里只有 id、没有参数，画布打开时预取 /api/runninghub/workflows/{id} 必然 404。
用户自己配置过（带 fields/workflowJson）的同 id 工作流必须原样保留。
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main


def legacy_empty(workflow_id, title):
    return {"id": workflow_id, "workflowId": workflow_id, "title": title, "enabled": True}


class RunningHubDefaultWorkflowRemovalTests(unittest.TestCase):

    def test_default_provider_emits_no_builtin_workflows(self):
        provider = next(p for p in main.default_api_providers() if p["id"] == "runninghub")
        self.assertEqual(provider.get("rh_workflows"), [])
        # 默认 AI 应用不受影响
        self.assertEqual(provider.get("rh_apps"), main.RUNNINGHUB_DEFAULT_APPS)

    def test_legacy_empty_entries_are_stripped(self):
        entries = [
            legacy_empty("2058541134623891458", "NanoBanana-2-图片编辑"),
            legacy_empty("2058554058318897153", "GPT-Image-2-图片编辑"),
            {"id": "keep-me", "workflowId": "keep-me", "title": "用户工作流", "fields": [{"id": "1::text"}]},
        ]
        self.assertEqual([entry["id"] for entry in main.strip_runninghub_legacy_default_workflows(entries)], ["keep-me"])

    def test_user_configured_legacy_id_is_preserved(self):
        entry = {"id": "2058541134623891458", "workflowId": "2058541134623891458", "workflowJson": {"1": {}}}
        self.assertEqual(main.strip_runninghub_legacy_default_workflows([entry]), [entry])

    def test_configured_provider_legacy_entries_are_cleaned_on_load(self):
        persisted = [
            {
                "id": "runninghub",
                "name": "RunningHub",
                "protocol": "runninghub",
                "enabled": True,
                "rh_apps": [],
                "rh_workflows": [
                    legacy_empty("2058541134623891458", "NanoBanana-2-图片编辑"),
                    legacy_empty("2058554058318897153", "GPT-Image-2-图片编辑"),
                ],
            }
        ]
        merged = main.merge_default_api_providers(persisted)
        rh = next(p for p in merged if p["id"] == "runninghub")
        self.assertEqual(rh.get("rh_workflows"), [])


if __name__ == "__main__":
    unittest.main()
