package org.erachain.dbs.rocksDB.transformation.differentLength;

import org.apache.flink.api.java.tuple.Tuple2;
import org.erachain.dbs.rocksDB.transformation.Byteable;
import org.erachain.dbs.rocksDB.transformation.ByteableInteger;
import org.erachain.dbs.rocksDB.transformation.ByteableLong;
import org.erachain.dbs.rocksDB.transformation.lists.ByteableList;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.Arrays;
import java.util.List;

public class ByteableTuple2BigDecimalListLong implements Byteable<Tuple2<BigDecimal, List<Long>>> {
    private final ByteableBigDecimal byteableBigDecimal = new ByteableBigDecimal();
    private final ByteableInteger byteableInteger = new ByteableInteger();
    private final ByteableList<Long> byteableListLong;

    public ByteableTuple2BigDecimalListLong() {
        byteableListLong = new ByteableList<Long>() {
            @Override
            public int sizeElement() {
                return Long.SIZE;
            }
        };
        byteableListLong.setByteableElement(new ByteableLong());
    }

    @Override
    public Tuple2<BigDecimal, List<Long>> receiveObjectFromBytes(byte[] bytes) {
        byte[] sizeArray = Arrays.copyOfRange(bytes, 0, Integer.BYTES);
        Integer size = byteableInteger.receiveObjectFromBytes(sizeArray);
        byte[] f0 = Arrays.copyOfRange(bytes, Integer.BYTES, Integer.BYTES + size);
        int newZero = Integer.BYTES + size;
        byte[] f1 = Arrays.copyOfRange(bytes, newZero, bytes.length);
        return Tuple2.of(new BigDecimal(new BigInteger(f0)), byteableListLong.receiveObjectFromBytes(f1));
    }

    @Override
    public byte[] toBytesObject(Tuple2<BigDecimal, List<Long>> value) {
        return org.bouncycastle.util.Arrays.concatenate(byteableBigDecimal.toBytesObject(value.f0), byteableListLong.toBytesObject(value.f1));
    }
}
