using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

[InitializeOnLoad]
public static class BekvamLaunch
{
    static BekvamLaunch()
    {
        if (System.Array.IndexOf(System.Environment.GetCommandLineArgs(), "-fitframe-joint") < 0 ||
            SessionState.GetBool("FitFrameJointStarted",false)) return;
        EditorApplication.delayCall += StartPreview;
    }

    private static void StartPreview()
    {
        SessionState.SetBool("FitFrameJointStarted",true);
        EditorSceneManager.OpenScene("Assets/Scenes/SampleScene.unity");
        EditorApplication.playModeStateChanged += AddPreview;
        EditorApplication.isPlaying = true;
    }

    private static void AddPreview(PlayModeStateChange state)
    {
        if (state == PlayModeStateChange.EnteredPlayMode)
            new GameObject("BEKVÄM assembly preview").AddComponent<BekvamPreview>();
    }
}
