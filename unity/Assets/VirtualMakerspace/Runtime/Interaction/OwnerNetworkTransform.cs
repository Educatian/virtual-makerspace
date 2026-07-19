using Unity.Netcode.Components;

namespace VirtualMakerspace.Interaction
{
    public sealed class OwnerNetworkTransform : NetworkTransform
    {
        protected override bool OnIsServerAuthoritative()
        {
            return false;
        }
    }
}