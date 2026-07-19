using UnityEngine;
using UnityEngine.XR;

namespace VirtualMakerspace
{
    public sealed class DesktopPreviewCameraGate : MonoBehaviour
    {
        [SerializeField] private Camera previewCamera;

        private void Start()
        {
            if (XRSettings.isDeviceActive)
            {
                previewCamera.enabled = false;
                AudioListener listener = previewCamera.GetComponent<AudioListener>();
                if (listener != null)
                {
                    listener.enabled = false;
                }
            }
        }
    }
}