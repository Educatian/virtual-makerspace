using System;
using System.Collections.Generic;

namespace VirtualMakerspace.Circuits
{
    public enum CircuitNode
    {
        PositiveRail,
        NegativeRail,
        RowA,
        RowB,
        RowC,
        RowD
    }

    public enum CircuitStatus
    {
        OpenCircuit,
        ReversedLed,
        MissingCurrentLimiter,
        Complete
    }

    public sealed class CircuitDefinition
    {
        private readonly List<Edge> _edges = new List<Edge>();
        private Led? _led;

        public void AddConductor(CircuitNode first, CircuitNode second)
        {
            _edges.Add(new Edge(first, second, false));
        }

        public void AddResistor(CircuitNode first, CircuitNode second, int resistanceOhms)
        {
            if (resistanceOhms <= 0)
            {
                throw new ArgumentOutOfRangeException(nameof(resistanceOhms));
            }

            _edges.Add(new Edge(first, second, true));
        }

        public void AddLed(CircuitNode anode, CircuitNode cathode)
        {
            _led = new Led(anode, cathode);
        }

        public CircuitStatus Evaluate()
        {
            if (!_led.HasValue)
            {
                return CircuitStatus.OpenCircuit;
            }

            Led led = _led.Value;
            bool cathodeReturns = HasPath(led.Cathode, CircuitNode.NegativeRail, false);
            bool anodePoweredWithResistance = HasPath(CircuitNode.PositiveRail, led.Anode, true);
            if (cathodeReturns && anodePoweredWithResistance)
            {
                return CircuitStatus.Complete;
            }

            bool anodePowered = HasPath(CircuitNode.PositiveRail, led.Anode, false);
            if (cathodeReturns && anodePowered)
            {
                return CircuitStatus.MissingCurrentLimiter;
            }

            bool reversed = HasPath(CircuitNode.PositiveRail, led.Cathode, false)
                && HasPath(led.Anode, CircuitNode.NegativeRail, false);
            return reversed ? CircuitStatus.ReversedLed : CircuitStatus.OpenCircuit;
        }

        private bool HasPath(CircuitNode start, CircuitNode target, bool requireResistance)
        {
            var pending = new Stack<PathState>();
            var visited = new HashSet<PathState>();
            pending.Push(new PathState(start, false));

            while (pending.Count > 0)
            {
                PathState current = pending.Pop();
                if (!visited.Add(current))
                {
                    continue;
                }

                if (current.Node == target && (!requireResistance || current.HasResistance))
                {
                    return true;
                }

                for (int index = 0; index < _edges.Count; index++)
                {
                    Edge edge = _edges[index];
                    if (edge.First == current.Node)
                    {
                        pending.Push(new PathState(edge.Second, current.HasResistance || edge.HasResistance));
                    }
                    else if (edge.Second == current.Node)
                    {
                        pending.Push(new PathState(edge.First, current.HasResistance || edge.HasResistance));
                    }
                }
            }

            return false;
        }

        private readonly struct Edge
        {
            public Edge(CircuitNode first, CircuitNode second, bool hasResistance)
            {
                First = first;
                Second = second;
                HasResistance = hasResistance;
            }

            public CircuitNode First { get; }
            public CircuitNode Second { get; }
            public bool HasResistance { get; }
        }

        private readonly struct Led
        {
            public Led(CircuitNode anode, CircuitNode cathode)
            {
                Anode = anode;
                Cathode = cathode;
            }

            public CircuitNode Anode { get; }
            public CircuitNode Cathode { get; }
        }

        private readonly struct PathState : IEquatable<PathState>
        {
            public PathState(CircuitNode node, bool hasResistance)
            {
                Node = node;
                HasResistance = hasResistance;
            }

            public CircuitNode Node { get; }
            public bool HasResistance { get; }

            public bool Equals(PathState other)
            {
                return Node == other.Node && HasResistance == other.HasResistance;
            }

            public override bool Equals(object obj)
            {
                return obj is PathState other && Equals(other);
            }

            public override int GetHashCode()
            {
                return HashCode.Combine((int)Node, HasResistance);
            }
        }
    }
}