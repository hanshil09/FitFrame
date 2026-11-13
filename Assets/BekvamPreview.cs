using System;
using System.Collections;
using System.Linq;
using UnityEngine;

public class BekvamPreview : MonoBehaviour
{
    [Serializable] private class Plan { public Action[] actions; }
    [Serializable] private class Action
    {
        public string caption, motion;
        public int[] nodes;
        public int entry_target;
        public float distance, seat_offset;
    }

    private string caption = "Loading BEKVÄM";
    private bool replay;
    private IEnumerator Start()
    {
        var model = Instantiate(Resources.Load<GameObject>("BekvamJoint"));
        var parts = model.GetComponentsInChildren<MeshRenderer>();
        MeshRenderer Find(string prefix) => parts.Single(r => r.name.StartsWith(prefix, StringComparison.Ordinal));
        var frame = Find("LEFT SIDE");
        var rail = Find("FRONT BOTTOM");
        var screw = Find("105215_05");
        var nodes = new System.Collections.Generic.Dictionary<int, MeshRenderer>
            {{1, frame}, {3, rail}, {10, screw}};
        var plan = JsonUtility.FromJson<Plan>(Resources.Load<TextAsset>("BekvamPlan").text);
        var bounds = frame.bounds;
        bounds.Encapsulate(rail.bounds);
        var outward = Vector3.ProjectOnPlane(screw.bounds.center - rail.bounds.center, Vector3.up).normalized;
        foreach (var renderer in nodes.Values)
        {
            var material = new Material(Shader.Find("Universal Render Pipeline/Lit"));
            material.color = renderer == screw ? new Color(.84f,.54f,.15f) :
                renderer == rail ? new Color(.12f,.55f,.49f) : new Color(.34f,.24f,.16f);
            renderer.material = material;
        }
        var camera = Camera.main;
        camera.orthographic = true;
        camera.orthographicSize = bounds.size.magnitude * .57f;
        camera.clearFlags = CameraClearFlags.SolidColor;
        camera.backgroundColor = new Color(.87f,.91f,.93f);
        camera.transform.position = bounds.center + (outward + Vector3.up*.52f + Vector3.Cross(outward,Vector3.up)*.67f).normalized * 2;
        camera.transform.LookAt(bounds.center);
        var poses = nodes.ToDictionary(pair => pair.Key, pair => (pair.Value.transform.position, pair.Value.transform.rotation));
        do
        {
            replay = false;
            foreach (var renderer in nodes.Values) renderer.enabled = false;
            foreach (var action in plan.actions)
            {
                caption = action.caption;
                var id = action.nodes[0];
                var renderer = nodes[id];
                var (position, rotation) = poses[id];
                var direction = id == 3 ? -outward : outward;
                renderer.enabled = true;
                for (float t = 0; t < 1.6f; t += Time.deltaTime)
                {
                    float progress = Mathf.SmoothStep(0,1,t/1.6f);
                    renderer.transform.SetPositionAndRotation(
                        position + direction * Mathf.Lerp(action.distance,action.seat_offset,progress),
                        id == 10 ? Quaternion.AngleAxis((progress-1)*540,direction)*rotation : rotation);
                    yield return null;
                }
                renderer.transform.SetPositionAndRotation(position+direction*action.seat_offset,rotation);
                yield return new WaitForSeconds(.65f);
            }
            yield return new WaitUntil(() => replay);
        } while (replay);
    }

    private void OnGUI()
    {
        GUI.Box(new Rect(16,16,Mathf.Min(Screen.width-32,680),83),"BEKVÄM 301.788.84  |  First rail joint");
        GUI.Label(new Rect(30,49,Screen.width-150,32),caption);
        if (GUI.Button(new Rect(Screen.width-110,Screen.height-58,94,38),"Replay")) replay = true;
    }
}
