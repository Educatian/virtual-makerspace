using UnityEngine;
using UnityEngine.XR.Interaction.Toolkit;
using UnityEngine.XR.Interaction.Toolkit.Interactors;

namespace VirtualMakerspace.Interaction
{
    [RequireComponent(typeof(XRSocketInteractor))]
    public sealed class BreadboardSocket : MonoBehaviour
    {
        [SerializeField] private int socketId;
        private XRSocketInteractor _socket;

        private void Awake()
        {
            PlacementRules.RequireValidSocketId(socketId);
            _socket = GetComponent<XRSocketInteractor>();
        }

        private void OnEnable()
        {
            _socket.selectEntered.AddListener(OnPartInserted);
        }

        private void OnDisable()
        {
            _socket.selectEntered.RemoveListener(OnPartInserted);
        }

        private void OnPartInserted(SelectEnterEventArgs args)
        {
            NetworkBreadboardPart part = args.interactableObject.transform.GetComponentInParent<NetworkBreadboardPart>();
            if (part != null)
            {
                part.RequestPlacement(socketId, transform.position, transform.rotation);
            }
        }
    }
}