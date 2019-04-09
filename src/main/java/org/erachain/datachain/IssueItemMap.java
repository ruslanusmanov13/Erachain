package org.erachain.datachain;

import com.google.common.primitives.UnsignedBytes;
import org.erachain.core.transaction.Transaction;
import org.mapdb.DB;

import java.util.HashMap;
import java.util.Map;
import java.util.TreeMap;

/**
 * Super Class for Issue Items
 *
 * Ключ: подпись создавшей класс записи - по идее надо поменять на ссылку
 * Значение - номер сущности
 *
 * Используется в org.erachain.core.transaction.IssueItemRecord#orphan(int)
 * TODO: поменять ссылку на запись с подписи на ссылку по номерам - и в таблицах ключ тоже на Лонг поменять
 * https://lab.erachain.org/erachain/Erachain/issues/465
 *
 */
public abstract class IssueItemMap extends DCMap<byte[], Long> {

    public IssueItemMap(DCSet databaseSet, DB database) {
        super(databaseSet, database);
    }

    public IssueItemMap(IssueItemMap parent) {
        super(parent, null);
    }

    protected void createIndexes(DB database) {
    }

    @Override
    protected Map<byte[], Long> getMemoryMap() {
        return new TreeMap<>(UnsignedBytes.lexicographicalComparator());
    }

    @Override
    protected Long getDefaultValue() {
        return 0L;
    }

    public Long get(Transaction transaction) {
        return get(transaction.getSignature());
    }

    public void set(Transaction transaction, Long key) {
        set(transaction.getSignature(), key);
    }

    public void delete(Transaction transaction) {
        delete(transaction.getSignature());
    }
}